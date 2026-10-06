const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const nativePools = [];
let nextId = 0;
let connectDelay = 0;
let queryDelay = 0;
let dropError = false;
let disconnectDelay = 0;
let disconnectFailures = 0;
let clearFailures = 0;
let clearDelay = 0;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name !== '@sap/hana-client') return originalLoad.call(this, name, ...args);
  return { createPool(_options, options) {
    const pool = { idle: [], active: 0, clears: 0, connections: [], options,
      clear(done) { pool.clears++; setTimeout(() => {
        if (clearFailures-- > 0) return done(new Error('clear secret failure'));
        pool.idle = []; done();
      }, clearDelay); },
      getConnection(done) {
        const physical = pool.idle.pop() ?? { id: ++nextId };
        const connection = { physical, closes: 0, aborted: 0,
          disconnect(cb) {
            connection.closes++;
            if (disconnectFailures-- > 0) return setImmediate(() => cb(new Error('disconnect secret failure')));
            setTimeout(() => { pool.active--; if (pool.idle.length < options.poolCapacity) pool.idle.push(physical); cb(); }, disconnectDelay);
          },
          abort(cb) { connection.aborted++; setImmediate(() => { connection.queryCallback?.(new Error('aborted')); cb(); }); },
          prepare(sql, cb) { setImmediate(() => cb(null, {
            functionCode: () => 5,
            drop: done => setImmediate(() => done(dropError ? new Error('drop failed') : undefined)),
            exec(_params, _opts, done) {
              connection.queryCallback = done;
              if (queryDelay) setTimeout(() => done(null, [{ ID: physical.id }]), queryDelay);
              else setImmediate(() => done(sql === 'BAD' ? new Error('SQL failed') : sql === 'SYNTAX' ? Object.assign(new Error('syntax failed'), { code: 257 }) : undefined, sql.includes('CURRENT_USER') ? [{ USER_NAME: 'TEST' }] : [{ ID: physical.id }]));
            },
          })); },
        };
        pool.active++; pool.connections.push(connection);
        setTimeout(() => done(null, connection), connectDelay);
      },
    };
    nativePools.push(pool); return pool;
  }};
};
const { acquireHanaLease, drainHanaPools } = require('../dist/nodes/SapHanaData/utils/HanaPool');
const { PooledHanaDataClient } = require('../dist/nodes/SapHanaData/utils/PooledHanaConnection');
const settings = { host: 'test', username: 'test', password: 'secret', poolMaxConnections: 1, poolMaxIdle: 1, poolAcquireTimeout: 100, poolIdleTimeout: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => { connectDelay = 0; queryDelay = 0; dropError = false; disconnectDelay = 0; clearDelay = 0; clearFailures = 0; disconnectFailures = 0; await drainHanaPools(); nativePools.length = 0; });

test('settled disconnect failure retries cleanup without double decrement or SQL retry', async () => {
  const a = await acquireHanaLease(settings, 'a'); disconnectFailures = 1;
  await Promise.all([a.release(), a.release()]);
  assert.equal(a.connection.closes, 2); assert.equal(nativePools[0].active, 0);
  assert.equal(nativePools[0].clears, 1);
  const b = await acquireHanaLease(settings, 'a'); await b.release();
});

test('clear failure recovers and concurrent retirement callers share cleanup', async () => {
  const a = await acquireHanaLease(settings, 'a'); await a.release(); clearFailures = 1;
  a.retire();
  const b = await acquireHanaLease(settings, 'a'); await b.release();
  assert.equal(nativePools[0].clears, 2);
});

test('exhausted clear failure is not permanently cached and logs exclude native messages', async () => {
  const logs = []; const warn = console.warn; console.warn = (...args) => logs.push(args.join(' '));
  try {
    const a = await acquireHanaLease(settings, 'a'); clearFailures = 3; a.retire();
    await assert.rejects(a.release(), /clear secret failure/);
    const b = await acquireHanaLease(settings, 'a'); await b.release();
    assert.equal(nativePools[0].clears, 4);
    assert.ok(logs.some(line => line.includes('pool-clear')));
    assert.ok(logs.every(line => !line.includes('secret')));
  } finally { console.warn = warn; }
});

test('ordinary SQL failure preserves pool and serves queued borrower', async () => {
  const a = new PooledHanaDataClient(settings, 'a'); await a.connect();
  const waiting = acquireHanaLease(settings, 'a');
  await assert.rejects(a.executeQuery('SYNTAX'), /syntax failed/); await a.disconnect();
  const b = await waiting; assert.equal(nativePools[0].clears, 0); await b.release();
});

test('permanent disconnect failure is quarantined with explicit recovery guidance', async () => {
  // Isolate the intentionally unrecoverable registry from the normal test drain.
  const path = require.resolve('../dist/nodes/SapHanaData/utils/HanaPool');
  const cached = require.cache[path]; delete require.cache[path];
  const isolated = require(path); require.cache[path] = cached;
  const a = await isolated.acquireHanaLease(settings, 'quarantine');
  disconnectFailures = 100;
  await assert.rejects(a.release(), /disconnect secret failure/);
  await assert.rejects(isolated.acquireHanaLease(settings, 'quarantine'), /Restart this worker/);
  assert.equal(a.connection.closes, 3);
  assert.equal(nativePools[0].clears, 0); assert.equal(nativePools.length, 1);
});

test('timed-out clear stays owned and cannot overlap a subsequent acquisition', async () => {
  const { bounded } = require('../dist/nodes/SapHanaData/utils/HanaPool');
  const a = await acquireHanaLease(settings, 'a'); await a.release(); clearDelay = 100;
  a.retire();
  const waiting = acquireHanaLease(settings, 'a');
  await assert.rejects(bounded(waiting, 10, 'test deadline'), /test deadline/);
  assert.equal(nativePools[0].clears, 1);
  const another = acquireHanaLease(settings, 'a');
  const b = await waiting; await b.release(); const c = await another; await c.release();
  assert.equal(nativePools[0].clears, 1); assert.equal(nativePools.length, 2);
});

test('reuses only after release, bounds active connections, and release is idempotent', async () => {
  const a = await acquireHanaLease(settings, 'a');
  let granted = false;
  const waiting = acquireHanaLease(settings, 'a').then(value => { granted = true; return value; });
  await sleep(10); assert.equal(granted, false); assert.equal(nativePools[0].active, 1);
  await Promise.all([a.release(), a.release()]);
  const b = await waiting; assert.equal(a.connection.physical, b.connection.physical);
  assert.equal(a.connection.closes, 1); await b.release();
});
test('queue overflow and cancelled waiter do not consume connections', async () => {
  const config = { ...settings, poolMaxPending: 1 };
  const a = await acquireHanaLease(config, 'a');
  const signal = new AbortController();
  const waiting = acquireHanaLease(config, 'a', signal.signal);
  await assert.rejects(acquireHanaLease(config, 'a'), /queue is full/);
  signal.abort(); await assert.rejects(waiting, /cancelled/);
  await a.release(); assert.equal(nativePools[0].connections.length, 1);
});
test('queue acquisition timeout leaves the existing borrower healthy', async () => {
  const a = await acquireHanaLease(settings, 'a');
  await assert.rejects(acquireHanaLease(settings, 'a'), /timed out/);
  await a.release(); const b = await acquireHanaLease(settings, 'a');
  assert.equal(b.connection.physical, a.connection.physical); await b.release();
});
test('late native acquisition after timeout is disposed and never reused', async () => {
  connectDelay = 150;
  await assert.rejects(acquireHanaLease(settings, 'a'), /timed out/);
  await sleep(70); assert.equal(nativePools[0].active, 0); assert.equal(nativePools[0].clears, 1);
});
test('cancellation during native acquisition disposes its late connection', async () => {
  connectDelay = 30; const signal = new AbortController();
  const waiting = acquireHanaLease(settings, 'a', signal.signal);
  await sleep(5); signal.abort(); await assert.rejects(waiting, /cancelled/);
  await sleep(40); assert.equal(nativePools[0].connections[0].closes, 1);
});
test('credential IDs isolate identical connection settings; password rotation retires old pool', async () => {
  const a = await acquireHanaLease(settings, 'a'); await a.release();
  const b = await acquireHanaLease(settings, 'b'); await b.release();
  assert.notEqual(a.connection.physical, b.connection.physical);
  const c = await acquireHanaLease({ ...settings, password: 'rotated' }, 'a'); await c.release();
  assert.equal(nativePools[0].clears, 1); assert.notEqual(a.connection.physical, c.connection.physical);
});
test('retirement rejects queued borrowers and waits for active leases before clearing', async () => {
  const a = await acquireHanaLease(settings, 'a');
  const waiting = acquireHanaLease(settings, 'a');
  a.retire(); await assert.rejects(waiting, /retired/);
  assert.equal(nativePools[0].clears, 0); await a.release(); assert.equal(nativePools[0].clears, 1);
});
test('idle expiry removes pool and physically clears its idle connections', async () => {
  const a = await acquireHanaLease(settings, 'a'); await a.release();
  await sleep(1100); assert.equal(nativePools[0].clears, 1);
});
test('invalid limits fail before loading/creating a native pool', async () => {
  await assert.rejects(acquireHanaLease({ ...settings, poolMaxConnections: 0 }, 'a'), /integer/);
  await assert.rejects(acquireHanaLease({ ...settings, poolMaxIdle: 2 }, 'a'), /integer/);
  assert.equal(nativePools.length, 0);
});
test('SQL and statement cleanup failures retire pool without retrying SQL', async () => {
  const a = new PooledHanaDataClient(settings, 'a'); await a.connect();
  await assert.rejects(a.executeQuery('BAD'), /SQL failed/); await a.disconnect();
  assert.equal(nativePools[0].connections.length, 1); assert.equal(nativePools[0].clears, 1);
  const b = new PooledHanaDataClient(settings, 'b'); await b.connect(); dropError = true;
  await assert.rejects(b.executeQuery('SELECT'), /drop failed/); await b.disconnect();
  assert.equal(nativePools[1].clears, 1);
});
test('cancellation aborts active SQL and disposal waits before release', async () => {
  const signal = new AbortController(); const a = new PooledHanaDataClient(settings, 'a', { signal: signal.signal });
  await a.connect(); queryDelay = 100;
  const work = a.executeQuery('SELECT'); await sleep(10); signal.abort();
  await assert.rejects(work, /cancelled/); await a.disconnect();
  assert.equal(nativePools[0].connections[0].aborted, 1); assert.equal(nativePools[0].clears, 1);
});
test('old cancellation signal cannot abort a subsequently borrowed connection', async () => {
  const signal = new AbortController(); const a = new PooledHanaDataClient(settings, 'a', { signal: signal.signal });
  await a.connect(); await a.disconnect();
  const b = new PooledHanaDataClient(settings, 'a'); await b.connect(); signal.abort();
  await b.executeQuery('SELECT'); await b.disconnect();
  assert.equal(nativePools[0].connections.reduce((sum, c) => sum + c.aborted, 0), 0);
});
test('query timeout aborts rather than returning a busy connection', async () => {
  const a = new PooledHanaDataClient(settings, 'a', { queryTimeoutMs: 10 });
  await a.connect(); queryDelay = 100;
  await assert.rejects(a.executeQuery('SELECT'), /timed out/); await a.disconnect();
  assert.equal(nativePools[0].connections[0].aborted, 1); assert.equal(nativePools[0].clears, 1);
});
test('already cancelled requests do not allocate empty registry entries', async () => {
  const signal = new AbortController(); signal.abort();
  for (let i = 0; i < 25; i++) await assert.rejects(acquireHanaLease(settings, `cancelled-${i}`, signal.signal), /cancelled/);
  assert.equal(nativePools.length, 0);
});
test('credential rotation cannot exceed capacity while the old lease is active', async () => {
  const a = await acquireHanaLease(settings, 'a');
  await assert.rejects(acquireHanaLease({ ...settings, password: 'rotated' }, 'a'), /draining/);
  assert.equal(nativePools.length, 1);
  await a.release();
  const b = await acquireHanaLease({ ...settings, password: 'rotated' }, 'a'); await b.release();
});
test('simultaneous rotation borrowers create only one replacement pool', async () => {
  const a = await acquireHanaLease(settings, 'a'); await a.release();
  const config = { ...settings, password: 'rotated' };
  const one = acquireHanaLease(config, 'a'); const two = acquireHanaLease(config, 'a');
  const b = await one; await b.release(); const c = await two; await c.release();
  assert.equal(nativePools.length, 2);
});
test('disconnect during SQL aborts and never releases a busy native request', async () => {
  const a = new PooledHanaDataClient(settings, 'a'); await a.connect(); queryDelay = 100;
  const work = a.executeQuery('SELECT'); const rejected = assert.rejects(work, /closed during operation/);
  await sleep(10); await a.disconnect(); await rejected;
  assert.equal(nativePools[0].connections[0].aborted, 1); assert.equal(nativePools[0].clears, 1);
});
test('every repeated disconnect remains bounded while late cleanup owns its slot', async () => {
  const a = new PooledHanaDataClient(settings, 'a', { cleanupTimeoutMs: 10 }); await a.connect(); disconnectDelay = 100;
  await assert.rejects(a.disconnect(), /release timed out/);
  await assert.rejects(a.disconnect(), /release timed out/);
  await assert.rejects(acquireHanaLease(settings, 'a'), /draining/);
  assert.equal(nativePools[0].connections[0].closes, 1);
  await sleep(120); assert.equal(nativePools[0].clears, 1);
});
