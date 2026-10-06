import { createHmac, randomBytes } from "crypto";
import type { Connection, ConnectionPool } from "@sap/hana-client";
import type { ICredentialDataDecryptedObject } from "n8n-workflow";

type Credentials = ICredentialDataDecryptedObject;
const secret = randomBytes(32);
const pools = new Set<Pool>();
const MAX_POOLS = 20;
let nextPoolId = 0;

// Never log native messages: they can contain SQL, parameters or credentials.
export function reportCleanup(phase: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(
    "[HANA cleanup]",
    JSON.stringify({
      phase,
      pid: process.pid,
      code: typeof code === "number" ? code : undefined,
    })
  );
}

// Retry only a completed native cleanup call, never a timed-out/pending call.
async function cleanupAttempt(
  phase: string,
  start: () => Promise<void>,
  failed?: () => void
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await start();
      if (attempt) reportCleanup(`${phase}:recovered`, undefined);
      return;
    } catch (error) {
      failed?.();
      reportCleanup(`${phase}:attempt-${attempt + 1}`, error);
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt ? 500 : 100));
    }
  }
}

export function callback<T>(
  start: (done: (error?: Error | null, value?: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      start((error, value) => (error ? reject(error) : resolve(value as T)));
    } catch (error) {
      reject(error);
    }
  });
}

export async function bounded<T>(
  work: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(
      `HANA pool setting must be an integer between ${min} and ${max}`
    );
  return number;
}

interface Waiter {
  grant: () => void;
  reject: (error: Error) => void;
}
export interface Lease {
  connection: Connection;
  retire: () => void;
  release: () => Promise<void>;
}

class Pool {
  private readonly diagnosticId = ++nextPoolId;
  readonly native: ConnectionPool;
  readonly limit: number;
  readonly waitMs: number;
  readonly pendingLimit: number;
  readonly idleMs: number;
  active = 0;
  retired = false;
  private waiters: Waiter[] = [];
  private timer?: NodeJS.Timeout;
  private clearing?: Promise<void>;
  private clearFailed = false;
  private quarantined = new Set<Connection>();

  constructor(
    readonly identity: string,
    readonly fingerprint: string,
    credentials: Credentials
  ) {
    this.limit = integer(credentials.poolMaxConnections, 5, 1, 50);
    const idle = integer(credentials.poolMaxIdle, 2, 1, this.limit);
    this.waitMs = integer(credentials.poolAcquireTimeout, 10000, 100, 300000);
    this.pendingLimit = integer(credentials.poolMaxPending, 20, 0, 1000);
    this.idleMs = integer(credentials.poolIdleTimeout, 60, 1, 3600) * 1000;
    const connectTimeout = integer(
      credentials.connectTimeout,
      15000,
      1000,
      300000
    );
    // Load only when pooling is enabled. The hdb fallback needs no native binary.
    let hana: typeof import("@sap/hana-client");
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      hana = require("@sap/hana-client");
    } catch {
      throw new Error(
        "SAP native driver could not load. Install a compatible @sap/hana-client environment (including ldd on Alpine x64), or disable connection pooling."
      );
    }
    this.native = hana.createPool(
      {
        host: credentials.host,
        port: credentials.port,
        uid: credentials.username,
        pwd: credentials.password,
        ...(credentials.database ? { databaseName: credentials.database } : {}),
        encrypt: credentials.encrypt ?? true,
        sslValidateCertificate: credentials.validateCertificate ?? true,
        connectTimeout,
        nodeConnectTimeout: connectTimeout,
        reconnect: false,
        allowReconnectOnSelect: false,
        distribution: "OFF",
      },
      {
        poolCapacity: idle,
        maxConnectedOrPooled: this.limit,
        maxPooledIdleTime: this.idleMs / 1000,
        maxWaitTimeoutIfPoolExhausted: 1,
        pingCheck: true,
        allowSwitchUser: false,
      }
    );
  }

  retire(): void {
    this.retired = true;
    if (this.timer) clearTimeout(this.timer);
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Error("HANA pool was retired"));
    if (this.active === 0 && !this.clearFailed) this.clearInBackground();
  }

  private clearInBackground(): void {
    void this.clear().catch((error) =>
      reportCleanup("pool-clear:failed", error)
    );
  }

  async finishRetirement(): Promise<void> {
    if (this.quarantined.size)
      throw new Error(
        "HANA connection cleanup failed; unresolved connections are quarantined. Restart this worker to recover safely."
      );
    if (this.active)
      throw new Error("Previous HANA credential pool is still draining");
    await bounded(this.clear(), 10000, "Previous HANA pool cleanup timed out");
  }

  private clear(): Promise<void> {
    if (!this.clearing) {
      // Keep failed/unfinished cleanup in the bounded registry: fail closed rather than
      // silently opening replacement pools while old sockets may still exist.
      this.clearFailed = false;
      if (process.env.HANA_POOL_DEBUG === "true")
        console.debug(
          "[HANA pool]",
          JSON.stringify({
            pid: process.pid,
            pool: this.diagnosticId,
            event: "clear-start",
          })
        );
      this.clearing = cleanupAttempt(
        `pool-${this.diagnosticId}:pool-clear`,
        () => callback<void>((done) => this.native.clear(done))
      ).then(
        () => {
          pools.delete(this);
          if (process.env.HANA_POOL_DEBUG === "true")
            console.debug(
              "[HANA pool]",
              JSON.stringify({
                pid: process.pid,
                pool: this.diagnosticId,
                event: "clear-success",
              })
            );
        },
        (error) => {
          this.clearing = undefined;
          this.clearFailed = true;
          throw error;
        }
      );
    }
    return this.clearing;
  }

  private completed(): void {
    this.active--;
    if (this.retired) {
      if (!this.active) this.clearInBackground();
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      this.active++;
      next.grant();
    }
    if (!this.active) {
      this.timer = setTimeout(() => this.retire(), this.idleMs);
      this.timer.unref();
    }
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("HANA execution cancelled");
    if (this.retired) throw new Error("HANA pool was retired");
    if (this.timer) clearTimeout(this.timer);
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    if (this.waiters.length >= this.pendingLimit)
      throw new Error("HANA pool waiting queue is full");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const remove = (error: Error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        cleanup();
        reject(error);
      };
      const cancel = () => remove(new Error("HANA execution cancelled"));
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const timer = setTimeout(
        () => remove(new Error("HANA pool acquisition timed out")),
        this.waitMs
      );
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiters.push(waiter);
    });
  }

  async acquire(signal?: AbortSignal): Promise<Lease> {
    const deadline = Date.now() + this.waitMs;
    await this.reserve(signal);
    let abandoned = false;
    let cancel!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("HANA execution cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    const acquired = callback<Connection>((done) =>
      this.native.getConnection(done)
    );
    const dispose = async (connection: Connection) => {
      try {
        await cleanupAttempt(
          `pool-${this.diagnosticId}:disconnect`,
          () => callback<void>((done) => connection.disconnect(done)),
          () => this.retire()
        );
      } catch (error) {
        this.quarantined.add(connection);
        this.retire();
        reportCleanup("disconnect:quarantined-worker-restart-required", error);
        throw error;
      }
      this.completed();
      if (this.retired && this.clearing) await this.clearing;
    };
    try {
      const connection = await bounded(
        Promise.race([acquired, cancellation]),
        Math.max(1, deadline - Date.now()),
        "HANA pool acquisition timed out"
      );
      if (this.retired || signal?.aborted)
        throw new Error("HANA pool acquisition cancelled");
      let released: Promise<void> | undefined;
      return {
        connection,
        retire: () => this.retire(),
        release: () => {
          if (!released)
            released = dispose(connection).catch((error) => {
              this.retire();
              throw error;
            });
          return released;
        },
      };
    } catch (error) {
      abandoned = true;
      this.retire();
      // Native acquisition cannot be cancelled. Keep its reservation until its late
      // callback arrives and the connection is disposed; never give it to a borrower.
      void acquired
        .then(dispose, () => this.completed())
        .catch((error) => reportCleanup("late-acquisition-disposal", error));
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (!abandoned && this.retired && !this.active) this.clearInBackground();
    }
  }
}

export async function acquireHanaLease(
  credentials: Credentials,
  credentialId: string,
  signal?: AbortSignal
): Promise<Lease> {
  if (signal?.aborted) throw new Error("HANA execution cancelled");
  if (!credentialId) throw new Error("Pooling requires an n8n credential ID");
  // A process-private keyed digest protects passwords and separates changes to every
  // effective connection/pool setting. Neither credentials nor digests are logged.
  const fingerprint = createHmac("sha256", secret)
    .update(
      JSON.stringify(
        Object.keys(credentials)
          .sort()
          .map((key) => [key, credentials[key]])
      )
    )
    .digest("hex");
  let match: Pool | undefined;
  for (const pool of pools) {
    if (pool.identity !== credentialId) continue;
    if (!pool.retired && pool.fingerprint === fingerprint) match = pool;
    else {
      pool.retire();
      await pool.finishRetirement();
      return await acquireHanaLease(credentials, credentialId, signal);
    }
  }
  if (!match) {
    if (pools.size >= MAX_POOLS)
      throw new Error(
        "HANA worker pool registry is full; wait for idle pools to close"
      );
    match = new Pool(credentialId, fingerprint, credentials);
    pools.add(match);
  }
  return await match.acquire(signal);
}

// Explicit drain for tests/hosts that provide a shutdown lifecycle. Do not install
// SIGTERM listeners in a community node: n8n owns process shutdown.
export async function drainHanaPools(): Promise<void> {
  for (const pool of pools) pool.retire();
  const deadline = Date.now() + 10000;
  while (pools.size && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (pools.size) throw new Error("HANA pools did not finish draining");
}
