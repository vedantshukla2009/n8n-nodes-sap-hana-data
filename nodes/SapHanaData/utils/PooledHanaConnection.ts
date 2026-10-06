import type {
  Connection,
  HanaParameterType,
  Statement,
} from "@sap/hana-client";
import type { ICredentialDataDecryptedObject } from "n8n-workflow";
import {
  HanaDataClient,
  HanaQueryResult,
  ExecutionOptions,
  normalizeResult,
} from "./HanaConnection";
import {
  acquireHanaLease,
  bounded,
  callback,
  Lease,
  reportCleanup,
} from "./HanaPool";

function ordinarySqlError(error: unknown): boolean {
  // Deliberately narrow: syntax, insufficient privilege, missing table/column,
  // and unique constraint violations. Unknown/native errors remain conservative.
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && [257, 258, 259, 260, 301].includes(code);
}

export class PooledHanaDataClient extends HanaDataClient {
  private lease?: Lease;
  private releaseWork?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();
  private abortWork?: Promise<void>;
  private cancelled?: Error;
  private cancellation = new AbortController();
  private executing = false;
  private initializing = false;
  private readonly cancel = () =>
    this.stop(new Error("HANA execution cancelled"));

  constructor(
    private readonly settings: ICredentialDataDecryptedObject,
    private readonly credentialId: string,
    private readonly execution: ExecutionOptions = {}
  ) {
    super(settings, execution);
  }

  async connect(): Promise<void> {
    if (this.lease || this.releaseWork)
      throw new Error("HANA client is already open or closing");
    this.cancelled = undefined;
    this.cancellation = new AbortController();
    this.abortWork = undefined;
    this.lease = await acquireHanaLease(
      this.settings,
      this.credentialId,
      this.execution.signal
    );
    this.execution.signal?.addEventListener("abort", this.cancel, {
      once: true,
    });
    try {
      this.initializing = true;
      if (this.execution.signal?.aborted) this.cancel();
      if (this.cancelled) throw this.cancelled;
      if (this.settings.currentSchema) {
        const schema = String(this.settings.currentSchema);
        const identifier = /^"(?:[^"]|"")+"$/.test(schema)
          ? schema
          : `"${schema.toUpperCase().replace(/"/g, '""')}"`;
        await this.executeQuery(`SET SCHEMA ${identifier}`);
      } else {
        // Explicit SAP pools can retain SET SCHEMA on this HANA version.
        // Restore the authenticated user's default schema on every checkout.
        const user = await this.executeQuery(
          "SELECT CURRENT_USER AS USER_NAME FROM DUMMY"
        );
        if (user.kind !== "rows" || typeof user.rows[0]?.USER_NAME !== "string")
          throw new Error("Could not determine HANA default schema");
        await this.executeQuery(
          `SET SCHEMA "${user.rows[0].USER_NAME.replace(/"/g, '""')}"`
        );
      }
    } catch (error) {
      await this.disconnect().catch((error) =>
        reportCleanup("initialization-disposal", error)
      );
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  private stop(error: Error): void {
    if (this.cancelled || !this.lease) return;
    this.cancelled = error;
    this.cancellation.abort(error);
    this.lease.retire();
    const connection = this.lease.connection;
    this.abortWork = callback<void>((done) => connection.abort(done));
    void this.abortWork.catch((error) => reportCleanup("abort", error));
  }

  private async operation<T>(
    start: (
      connection: Connection,
      done: (error?: Error | null, value?: T) => void
    ) => void,
    ms: number,
    isSql = false
  ): Promise<T> {
    if (!this.lease || this.releaseWork)
      throw new Error("HANA client is not connected");
    if (this.cancelled) throw this.cancelled;
    const connection = this.lease.connection;
    const work = callback<T>((done) => start(connection, done));
    this.pending = work.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(this.cancelled);
      this.cancellation.signal.addEventListener("abort", cancel, {
        once: true,
      });
    });
    if (ms > 0)
      timer = setTimeout(
        () => this.stop(new Error("HANA query execution timed out")),
        ms
      );
    try {
      const result = await Promise.race([work, cancelled]);
      if (this.cancelled) throw this.cancelled;
      return result;
    } catch (error) {
      if (!isSql || this.cancelled || !ordinarySqlError(error))
        this.lease.retire();
      throw this.cancelled ?? error;
    } finally {
      if (timer) clearTimeout(timer);
      this.cancellation.signal.removeEventListener("abort", cancel);
    }
  }

  async executeQuery(
    query: string,
    params: unknown[] = []
  ): Promise<HanaQueryResult> {
    if (this.executing)
      throw new Error(
        "Concurrent operations on one HANA lease are not supported"
      );
    this.executing = true;
    const timeout = this.initializing
      ? Number(this.settings.connectTimeout ?? 15000)
      : this.execution.queryTimeoutMs;
    const deadline = timeout ? Date.now() + timeout : 0;
    const remaining = () => (deadline ? Math.max(1, deadline - Date.now()) : 0);
    let statement: Statement | undefined;
    let failure: unknown;
    let cleanupError: unknown;
    let result!: HanaQueryResult;
    try {
      statement = await this.operation<Statement>(
        (connection, done) => connection.prepare(query, done),
        remaining(),
        true
      );
      const prepared = statement;
      const procedure = [8, 9].includes(prepared.functionCode());
      result = await this.operation<HanaQueryResult>(
        (_connection, done) => {
          prepared.exec(
            params as HanaParameterType[],
            { returnMultipleResultSets: procedure },
            (error: Error, result: unknown, ...sets: unknown[]) => {
              if (error) return done(error);
              try {
                // SAP appends one column-info array per table after the table arrays.
                // A scalar-only CALL returns one empty placeholder and no column info.
                const tables = procedure
                  ? sets.length === 1
                    ? []
                    : sets.slice(0, sets.length / 2)
                  : sets;
                if (procedure && sets.length > 1 && sets.length % 2)
                  throw new Error("Unexpected SAP procedure result metadata");
                done(undefined, normalizeResult(result, tables));
              } catch (error) {
                done(error as Error);
              }
            }
          );
        },
        remaining(),
        true
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        if (statement && !this.cancelled) {
          const prepared = statement;
          await this.operation<void>(
            (_connection, done) => prepared.drop(done),
            this.execution.cleanupTimeoutMs ?? 5000
          );
        }
      } catch (error) {
        reportCleanup("statement-drop", error);
        if (!failure) cleanupError = error;
      } finally {
        this.executing = false;
      }
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.releaseWork)
      return await bounded(
        this.releaseWork,
        this.execution.cleanupTimeoutMs ?? 5000,
        "HANA pool release timed out"
      );
    if (!this.lease) return;
    if (this.executing)
      this.stop(new Error("HANA connection closed during operation"));
    this.execution.signal?.removeEventListener("abort", this.cancel);
    const lease = this.lease;
    // Never return a connection while its native request/abort callback is still
    // running. If disposal exceeds its deadline, cleanup continues with ownership.
    this.releaseWork = (async () => {
      await this.pending;
      if (this.abortWork) await this.abortWork.catch(() => undefined);
      await lease.release(); // SAP rolls back and resets the session on release.
      this.lease = undefined;
    })();
    try {
      await bounded(
        this.releaseWork,
        this.execution.cleanupTimeoutMs ?? 5000,
        "HANA pool release timed out"
      );
    } catch (error) {
      lease.retire();
      reportCleanup("release:failed-or-unfinished", error);
      throw error;
    }
  }
}
