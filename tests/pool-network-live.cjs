// Inject a network failure into a test-owned proxy, never into the user's tunnel.
const net = require('node:net');
const assert = require('node:assert/strict');
const { PooledHanaDataClient } = require('../dist/nodes/SapHanaData/utils/PooledHanaConnection');
const { drainHanaPools } = require('../dist/nodes/SapHanaData/utils/HanaPool');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main(credentials) {
  const sockets = new Set();
  const proxy = net.createServer(front => {
    const back = net.connect({ host: credentials.host, port: credentials.port });
    for (const socket of [front, back]) {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    }
    front.on('close', () => back.destroy()); back.on('close', () => front.destroy());
    front.pipe(back); back.pipe(front);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const settings = { ...credentials, host: '127.0.0.1', port: proxy.address().port, poolMaxConnections: 1, poolMaxIdle: 1 };
  const query = async () => {
    const client = new PooledHanaDataClient(settings, 'network-test', { queryTimeoutMs: 5000 });
    try { await client.connect(); return (await client.executeQuery('SELECT CURRENT_CONNECTION AS ID FROM DUMMY')).rows[0].ID; }
    finally { await client.disconnect(); }
  };
  try {
    const before = await query();
    for (const socket of sockets) socket.destroy();
    await sleep(2500);
    const after = await query();
    assert.notEqual(before, after);
    console.log('PASS native viability check replaces disconnected idle session before SQL');
  } finally {
    await drainHanaPools();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
}
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => main(JSON.parse(input)).catch(error => { console.error(error.message); process.exitCode = 1; }));
