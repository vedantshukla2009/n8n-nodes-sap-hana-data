// Credentials enter through stdin only. Creates and removes uniquely named test objects.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PooledHanaDataClient } = require('../dist/nodes/SapHanaData/utils/PooledHanaConnection');
const { drainHanaPools, acquireHanaLease, callback } = require('../dist/nodes/SapHanaData/utils/HanaPool');
async function main(credentials) {
  const settings = { ...credentials, pooling: true, poolMaxConnections: 2, poolMaxIdle: 2, poolIdleTimeout: 2 };
  const client = () => new PooledHanaDataClient(settings, 'live-pool', { queryTimeoutMs: 10000 });
  const first = client();
  const second = client();
  const name = `N8N_POOL_TEST_${randomBytes(6).toString('hex').toUpperCase()}`;
  let created = false;
  try {
    await first.connect();
    const id = (await first.executeQuery('SELECT CURRENT_CONNECTION AS ID FROM DUMMY')).rows[0].ID;
    await assert.rejects(first.executeQuery('SELECT FROM DUMMY'), error => error.code === 257);
    await first.executeQuery(`CREATE PROCEDURE "${name}" (OUT N INTEGER) LANGUAGE SQLSCRIPT AS BEGIN N = 7; SELECT 1 AS A FROM DUMMY; SELECT 2 AS B FROM DUMMY; END`);
    created = true;
    await first.disconnect();
    await second.connect();
    assert.equal((await second.executeQuery('SELECT CURRENT_CONNECTION AS ID FROM DUMMY')).rows[0].ID, id);
    console.log('PASS physical connection reused across leases');
    console.log('PASS syntax error preserves physical pooled connection');
    const result = await second.executeCustomQuery(`CALL "${name}"(?)`);
    assert.deepEqual(result, { kind: 'procedure', outputParameters: { N: 7 }, resultSets: [[{ A: 1 }], [{ B: 2 }]] });
    console.log('PASS CALL scalar outputs and multiple result sets');
    await second.executeQuery(`DROP PROCEDURE "${name}"`); created = false;
    await second.executeQuery(`CREATE PROCEDURE "${name}" (INOUT N INTEGER) LANGUAGE SQLSCRIPT AS BEGIN N = :N + 1; END`); created = true;
    assert.deepEqual(await second.executeCustomQuery(`CALL "${name}"(?)`, [4]), { kind: 'procedure', outputParameters: { N: 5 }, resultSets: [] });
    await second.executeQuery(`DROP PROCEDURE "${name}"`); created = false;
    console.log('PASS scalar-only INOUT CALL has no phantom result sets');
    await second.executeQuery(`CREATE PROCEDURE "${name}" () LANGUAGE SQLSCRIPT AS BEGIN SELECT 1 AS A FROM DUMMY WHERE 1 = 0; SELECT 2 AS B FROM DUMMY; END`); created = true;
    assert.deepEqual(await second.executeCustomQuery(`CALL "${name}"()`), { kind: 'procedure', outputParameters: {}, resultSets: [[], [{ B: 2 }]] });
    await second.executeQuery(`DROP PROCEDURE "${name}"`); created = false;
    console.log('PASS empty first CALL dataset is preserved');
    await second.disconnect();
    const lease = await acquireHanaLease(settings, 'live-pool');
    try {
      await callback(done => lease.connection.exec('SET SCHEMA SYS', done));
      lease.connection.setClientInfo('N8N_POOL_TEST', 'must-not-leak');
    } finally { await lease.release(); }
    const reset = await acquireHanaLease(settings, 'live-pool');
    try {
      assert.ok(!reset.connection.getClientInfo('N8N_POOL_TEST'), 'client info must be reset');
    } finally { await reset.release(); }
    const schemaClient = client();
    try {
      await schemaClient.connect();
      assert.notEqual((await schemaClient.executeQuery('SELECT CURRENT_SCHEMA AS S FROM DUMMY')).rows[0].S, 'SYS');
    } finally { await schemaClient.disconnect(); }
    console.log('PASS checkout resets schema and SAP release clears client session variables');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const third = client();
    try {
      await third.connect();
      assert.notEqual((await third.executeQuery('SELECT CURRENT_CONNECTION AS ID FROM DUMMY')).rows[0].ID, id);
      console.log('PASS idle expiry opens a new physical connection');
    } finally { await third.disconnect(); }
    const lock = await acquireHanaLease(settings, 'live-pool');
    const table = `"${name}_LOCK"`;
    let tableCreated = false;
    try {
      await callback(done => lock.connection.exec(`CREATE TABLE ${table} (ID INTEGER PRIMARY KEY, V INTEGER)`, done)); tableCreated = true;
      await callback(done => lock.connection.exec(`INSERT INTO ${table} VALUES (1, 0)`, done));
      lock.connection.setAutoCommit(false);
      await callback(done => lock.connection.exec(`UPDATE ${table} SET V = 1 WHERE ID = 1`, done));
      const blocked = new PooledHanaDataClient(settings, 'live-pool', { queryTimeoutMs: 200 });
      try {
        await blocked.connect();
        await assert.rejects(blocked.executeQuery(`UPDATE ${table} SET V = 2 WHERE ID = 1`), /timed out/);
      } finally { await blocked.disconnect(); }
      await lock.release();
      console.log('PASS real lock-wait timeout aborts query and retires pool');
      const verify = client();
      try {
        await verify.connect();
        assert.equal((await verify.executeQuery(`SELECT V FROM ${table}`)).rows[0].V, 0);
        await verify.executeQuery(`DROP TABLE ${table}`); tableCreated = false;
        console.log('PASS release rolls back an unfinished transaction');
      } finally { await verify.disconnect(); }
    } finally {
      await lock.release();
      if (tableCreated) {
        const clean = client();
        try { await clean.connect(); await clean.executeQuery(`DROP TABLE ${table}`); }
        finally { await clean.disconnect(); }
      }
    }
  } catch (error) { console.error(`Live test ${name} failed:`, error.message); throw error; } finally {
    await first.disconnect().catch(() => {}); await second.disconnect().catch(() => {});
    if (created) {
      const cleanup = client();
      try { await cleanup.connect(); await cleanup.executeQuery(`DROP PROCEDURE "${name}"`); }
      finally { await cleanup.disconnect(); }
    }
    await drainHanaPools();
  }
}
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => main(JSON.parse(input)).catch(error => { console.error(error.message); process.exitCode = 1; }));
