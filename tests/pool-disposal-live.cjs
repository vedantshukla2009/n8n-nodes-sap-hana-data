// Credentials enter through stdin. Uses only this script's read-only sessions.
const assert = require('node:assert/strict');
const hana = require('@sap/hana-client');
const { acquireHanaLease, drainHanaPools, callback } = require('../dist/nodes/SapHanaData/utils/HanaPool');
async function main(credentials) {
  const settings = { ...credentials, poolMaxConnections: 1, poolMaxIdle: 1 };
  try {
    for (const afterNativeRelease of [false, true]) {
      const lease = await acquireHanaLease(settings, `disposal-${afterNativeRelease}`);
      const original = lease.connection.disconnect.bind(lease.connection);
      let calls = 0;
      Object.defineProperty(lease.connection, 'disconnect', { value: done => {
        calls++;
        if (calls !== 1) return original(done);
        const failure = () => done(new Error('Injected settled release failure'));
        if (afterNativeRelease) original(error => error ? done(error) : failure());
        else setImmediate(failure);
      }});
      await lease.release();
      assert.equal(calls, 2);
      const replacement = await acquireHanaLease(settings, `disposal-${afterNativeRelease}`);
      await callback(done => replacement.connection.exec('SELECT 1 AS N FROM DUMMY', done));
      await replacement.release();
      console.log(`PASS release recovery ${afterNativeRelease ? 'after' : 'before'} native release`);
    }
    const pool = hana.createPool({ host: credentials.host, port: credentials.port,
      uid: credentials.username, pwd: credentials.password, encrypt: credentials.encrypt ?? true });
    const connection = await callback(done => pool.getConnection(done));
    await callback(done => connection.disconnect(done));
    await callback(done => connection.disconnect(done));
    assert.equal(pool.getInUseCount(), 0);
    await callback(done => pool.clear(done));
    await callback(done => pool.clear(done));
    assert.equal(pool.getPooledCount(), 0);
    console.log('PASS native repeated disconnect and clear are safe after completed success');
  } finally { await drainHanaPools(); }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => main(JSON.parse(input)).catch(error => {
  console.error('Disposal test failed:', error.code ?? error.name); process.exitCode = 1;
}));
