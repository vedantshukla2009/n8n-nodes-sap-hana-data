const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const hdb = require('hdb');
const { HanaDataClient } = require('../dist/nodes/SapHanaData/utils/HanaConnection');
const { SapHanaData } = require('../dist/nodes/SapHanaData/SapHanaData.node');

afterEach(() => mock.restoreAll());
const credentials = { host: '127.0.0.1', port: 1, username: 'test', password: 'test', encrypt: false };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeDriver(overrides = {}) {
  const events = [];
  const client = new EventEmitter();
  client.readyState = 'new';
  const statement = {
    exec: (_values, callback) => callback(null, {}, [{ ID: 1 }]),
    drop: (callback) => { events.push('drop'); setImmediate(() => { events.push('dropped'); callback(); }); },
    ...overrides.statement,
  };
  Object.assign(client, {
    connect(callback) { client.readyState = 'connected'; callback(); },
    prepare(_sql, callback) { events.push('prepare'); callback(null, statement); },
    exec(_sql, callback) { callback(null, [{ ID: 1 }]); },
    disconnect(callback) { events.push('disconnect'); callback(); setImmediate(() => client.destroy()); },
    destroy() {
      if (client.readyState === 'closed') return;
      client.readyState = 'closed';
      setImmediate(() => { events.push('closed'); client.emit('close'); });
    },
    ...overrides.client,
  });
  mock.method(hdb, 'createClient', (options) => {
    client.options = options;
    options.signal.addEventListener('abort', () => client.destroy(), { once: true });
    return client;
  });
  return { client, statement, events };
}

test('CALL captures scalar outputs and every dataset, then awaits statement disposal', async () => {
  const { events } = fakeDriver({ statement: { exec: (_params, callback) => callback(null, { TOTAL: 2 }, [{ ID: 1 }], []) } });
  const client = new HanaDataClient(credentials);
  await client.connect();
  assert.deepEqual(await client.executeCustomQuery('/* comment */ CALL P(?)'), {
    kind: 'procedure', outputParameters: { TOTAL: 2 }, resultSets: [[{ ID: 1 }], []],
  });
  assert.deepEqual(events, ['prepare', 'drop', 'dropped']);
  await client.disconnect();
  assert.deepEqual(events, ['prepare', 'drop', 'dropped', 'disconnect', 'closed']);
});

test('SELECT, DML, batch DML and DDL remain distinct result types', async () => {
  const { statement } = fakeDriver();
  const client = new HanaDataClient(credentials);
  await client.connect();
  for (const [value, expected] of [
    [[{ ID: 1 }], { kind: 'rows', rows: [{ ID: 1 }] }],
    [[], { kind: 'rows', rows: [] }],
    [0, { kind: 'statement', affectedRows: 0 }],
    [[1, 2], { kind: 'statement', affectedRows: [1, 2] }],
    [undefined, { kind: 'statement' }],
  ]) {
    statement.exec = (_params, callback) => callback(null, value);
    assert.deepEqual(await client.executeCustomQuery('SQL'), expected);
  }
  await client.disconnect();
});

test('only leading ordinary comments are removed, preserving literals and hints', async () => {
  const preparedSql = [];
  const { statement } = fakeDriver({ client: {
    prepare(sql, callback) { preparedSql.push(sql); callback(null, statement); },
  } });
  const client = new HanaDataClient(credentials);
  await client.connect();
  await client.executeCustomQuery(" \n/* header */\n-- note\nCALL P('/* literal */')");
  await client.executeCustomQuery('/*+ hint */ CALL P()');
  assert.deepEqual(preparedSql, ["CALL P('/* literal */')", '/*+ hint */ CALL P()']);
  await assert.rejects(client.executeCustomQuery('/* only a comment */'), /SQL query is required/);
  await client.disconnect();
});

test('failed preparation still closes the node connection', async () => {
  const { events } = fakeDriver({ client: { prepare(_sql, callback) { callback(new Error('invalid SQL')); } } });
  await assert.rejects(new SapHanaData().execute.call(nodeContext()), /invalid SQL/);
  assert.deepEqual(events, ['disconnect', 'closed']);
});

test('concurrent and repeated disconnect calls wait for one physical close', async () => {
  const { events } = fakeDriver();
  const client = new HanaDataClient(credentials);
  await client.connect();
  await Promise.all([client.disconnect(), client.disconnect()]);
  await client.disconnect();
  assert.deepEqual(events, ['disconnect', 'closed']);
  await assert.rejects(client.executeCustomQuery('CALL P()'), /not connected/);
});

test('SQL error takes precedence over a statement cleanup error', async () => {
  const { events } = fakeDriver({ statement: {
    exec: (_params, callback) => callback(Object.assign(new Error('primary SQL failure'), { code: 10001 })),
    drop: (callback) => callback(new Error('secondary drop failure')),
  } });
  const client = new HanaDataClient(credentials);
  await client.connect();
  await assert.rejects(client.executeCustomQuery('CALL P()'), { message: 'Query execution failed: primary SQL failure', code: 10001 });
  await client.disconnect();
  assert.ok(events.includes('closed'));
});

test('statement cleanup timeout forces disposal and reports failure', async () => {
  const { events } = fakeDriver({ statement: { drop() {} } });
  const client = new HanaDataClient(credentials, { cleanupTimeoutMs: 25 });
  await client.connect();
  await assert.rejects(client.executeCustomQuery('CALL P()'), /statement cleanup timed out/);
  await client.disconnect();
  assert.ok(events.includes('closed'));
});

test('stalled graceful disconnect falls back to physical destruction', async () => {
  const { events } = fakeDriver({ client: { disconnect() {} } });
  const client = new HanaDataClient(credentials, { cleanupTimeoutMs: 25 });
  await client.connect();
  await client.disconnect();
  assert.ok(events.includes('closed'));
});

test('query timeout aborts the transport without retrying', async () => {
  let executions = 0;
  const { events } = fakeDriver({ statement: { exec() { executions++; } } });
  const client = new HanaDataClient(credentials, { queryTimeoutMs: 25 });
  await client.connect();
  await assert.rejects(client.executeCustomQuery('CALL P()'), /query execution timed out/);
  await client.disconnect();
  assert.equal(executions, 1);
  assert.ok(events.includes('closed'));
});

test('workflow cancellation rejects active SQL and closes the socket', async () => {
  const { events } = fakeDriver({ statement: { exec() {} } });
  const controller = new AbortController();
  const client = new HanaDataClient(credentials, { signal: controller.signal });
  await client.connect();
  const result = assert.rejects(client.executeCustomQuery('CALL P()'), /cancelled/);
  await tick();
  controller.abort();
  await result;
  await client.disconnect();
  assert.ok(events.includes('closed'));
});

test('socket closure during SQL rejects instead of hanging', async () => {
  const { client: driver } = fakeDriver({ statement: { exec() { setImmediate(() => driver.destroy()); } } });
  const client = new HanaDataClient(credentials);
  await client.connect();
  await assert.rejects(client.executeCustomQuery('CALL P()'), /closed during operation/);
  await client.disconnect();
});

test('failed schema setup closes the established connection', async () => {
  const { events } = fakeDriver({ client: { exec(_sql, callback) { callback(new Error('missing schema')); } } });
  const client = new HanaDataClient({ ...credentials, currentSchema: 'missing' });
  await assert.rejects(client.connect(), /missing schema/);
  assert.ok(events.includes('closed'));
});

test('already-cancelled execution never creates a connection', async () => {
  const create = mock.method(hdb, 'createClient', () => { throw new Error('Must not connect'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new HanaDataClient(credentials, { signal: controller.signal }).connect(), /cancelled/);
  assert.equal(create.mock.callCount(), 0);
});

for (const encrypt of [false, true]) {
  test(`connect timeout aborts a real stalled ${encrypt ? 'TLS' : 'HANA'} handshake`, { timeout: 5000 }, async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new HanaDataClient({ ...credentials, port: server.address().port, encrypt, connectTimeout: 80 }, { cleanupTimeoutMs: 500 });
    try {
      await assert.rejects(client.connect(), /timed out|initialization reply/);
      await client.disconnect();
      for (let i = 0; i < 20 && sockets.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sockets.size, 0, 'No transport remains after failed connect');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

function nodeContext(settings = {}) {
  return {
    getInputData: () => [{ json: {} }],
    getCredentials: async () => credentials,
    getExecutionCancelSignal: () => settings.signal,
    getNode: () => ({ name: 'Test HANA', type: 'sapHanaData', typeVersion: 1, position: [0, 0], parameters: {} }),
    continueOnFail: () => settings.continueOnFail ?? false,
    getNodeParameter: (name, _index, fallback) => ({ operation: 'customApiCall', customQuery: 'CALL P()', includeMetadata: false, ...settings }[name] ?? fallback),
  };
}

test('node emits a procedure envelope even when Return Array Format is enabled', async () => {
  fakeDriver();
  const [[item]] = await new SapHanaData().execute.call(nodeContext({ returnArrayFormat: true }));
  assert.deepEqual(item.json, { success: true, outputParameters: {}, resultSets: [[{ ID: 1 }]], rowCount: 1 });
  assert.deepEqual(item.pairedItem, { item: 0 });
});

test('cleanup failure cannot emit both a success item and an error item', async () => {
  mock.method(HanaDataClient.prototype, 'connect', async () => {});
  mock.method(HanaDataClient.prototype, 'executeCustomQuery', async () => ({ kind: 'rows', rows: [{ ID: 1 }] }));
  mock.method(HanaDataClient.prototype, 'disconnect', async () => { throw new Error('cleanup failed'); });
  const [items] = await new SapHanaData().execute.call(nodeContext({ continueOnFail: true }));
  assert.equal(items.length, 1);
  assert.equal(items[0].json.success, false);
  assert.equal(items[0].json.error.message, 'cleanup failed');
});

test('node preserves primary error when disconnect also fails', async () => {
  mock.method(HanaDataClient.prototype, 'connect', async () => {});
  mock.method(HanaDataClient.prototype, 'executeCustomQuery', async () => { throw new Error('primary SQL error'); });
  mock.method(HanaDataClient.prototype, 'disconnect', async () => { throw new Error('cleanup failed'); });
  await assert.rejects(new SapHanaData().execute.call(nodeContext()), /primary SQL error/);
});
