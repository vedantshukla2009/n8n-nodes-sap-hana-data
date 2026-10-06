// Run from repository root. Feed HANA credentials as JSON on stdin; never saved on host.
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { HanaDataClient } = require('../../dist/nodes/SapHanaData/utils/HanaConnection');
const compose = ['compose', '-f', 'tests/docker/compose.yml'];
function docker(args, input) {
  const result = spawnSync('docker', [...compose, ...args], { input, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch('http://127.0.0.1:15678/healthz/readiness'); if (r.ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error('n8n readiness timeout');
}
function writeContainer(path, data) {
  docker(['exec', '-T', 'n8n', 'node', '-e', `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(path)},s,{mode:384}))`], JSON.stringify(data));
}
function workflow(id, path, credential, query, fresh = false) {
  return {
    id, name: `HANA pool test ${path}`, active: true, versionId: randomUUID(), settings: { executionOrder: 'v1' },
    nodes: [
      { id: randomUUID(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0,0], webhookId: randomUUID(), parameters: { path, httpMethod: 'GET', responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} } },
      { id: randomUUID(), name: 'HANA', type: 'CUSTOM.sapHanaData', typeVersion: 1, position: [220,0], credentials: { sapHanaDataApi: { id: credential, name: credential } }, parameters: { operation: 'customApiCall', customQuery: query, freshConnection: fresh, includeMetadata: false, returnArrayFormat: false, queryTimeout: 10 } },
    ],
    connections: { Webhook: { main: [[{ node: 'HANA', type: 'main', index: 0 }]] } },
  };
}
async function main(credentials) {
  await ready();
  const setup = await fetch('http://127.0.0.1:15678/rest/owner/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pool-test@example.invalid', firstName: 'Pool', lastName: 'Test', password: `Test-${randomBytes(12).toString('hex')}!1` }) });
  if (!setup.ok && setup.status !== 400) throw new Error(`Owner setup failed ${setup.status}`);
  const name = `N8N_QUEUE_TEST_${randomBytes(6).toString('hex').toUpperCase()}`;
  const admin = new HanaDataClient(credentials, { queryTimeoutMs: 15000 });
  let created = false;
  const ids = new Set();
  try {
    await admin.connect();
    await admin.executeQuery(`CREATE PROCEDURE "${name}" (OUT N INTEGER) LANGUAGE SQLSCRIPT AS BEGIN N = 7; SELECT CURRENT_CONNECTION AS ID FROM DUMMY; SELECT 2 AS B FROM DUMMY; END`);
    created = true;
    await admin.disconnect();
    const data = { ...credentials, host: 'host.docker.internal', pooling: true, poolMaxConnections: 5, poolMaxIdle: 2, poolIdleTimeout: 5, poolAcquireTimeout: 15000 };
    writeContainer('/tmp/hana-credentials.json', [{ id: 'hana-pool-test', name: 'hana-pool-test', type: 'sapHanaDataApi', data }]);
    try { docker(['exec', '-T', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/hana-credentials.json']); }
    finally { docker(['exec', '-T', 'n8n', 'node', '-e', 'require("fs").unlinkSync("/tmp/hana-credentials.json")']); }
    const workflows = [
      workflow('hanaPoolCall', 'hana-pool-call', 'hana-pool-test', `CALL "${name}"(?)`),
      workflow('hanaPoolError', 'hana-pool-error', 'hana-pool-test', 'SELECT * FROM "N8N_POOL_NONEXISTENT_TABLE"'),
      workflow('hanaPoolFresh', 'hana-pool-fresh', 'hana-pool-test', `CALL "${name}"(?)`, true),
    ];
    writeContainer('/tmp/hana-workflows.json', workflows);
    docker(['exec', '-T', 'n8n', 'n8n', 'import:workflow', '--input=/tmp/hana-workflows.json', '--activeState=fromJson']);
    docker(['restart', 'n8n', 'worker']); await ready(); await sleep(2000);
    async function call(path = 'hana-pool-call') {
      const response = await fetch(`http://127.0.0.1:15678/webhook/${path}`, { signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      assert.equal(response.status, 200, `Webhook failed: ${text.slice(0,500)}`);
      const data = JSON.parse(text);
      assert.equal(data.outputParameters.N, 7, JSON.stringify(data));
      assert.deepEqual(data.resultSets[1], [{ B: 2 }]);
      ids.add(data.resultSets[0][0].ID);
      return data.resultSets[0][0].ID;
    }
    // Check dedicated connections before burst traffic through the local tunnel.
    const freshA = await call('hana-pool-fresh'); await sleep(2500); const freshB = await call('hana-pool-fresh');
    assert.notEqual(freshA, freshB); console.log('PASS dedicated CALL mode closes each connection');
    await sleep(2500);
    const sequential = [];
    for (let i = 0; i < 12; i++) sequential.push(await call());
    assert.ok(new Set(sequential).size <= 3, 'Sequential requests should reuse at most one session per worker');
    console.log(`PASS 12 queued CALLs reused ${new Set(sequential).size} physical sessions`);
    for (let wave = 0; wave < 4; wave++) {
      await Promise.all(Array.from({ length: 9 }, () => call()));
      await sleep(2500); // Allow the local test tunnel to settle between connection bursts.
    }
    console.log('PASS 36 concurrent queued CALLs returned all datasets and scalar outputs');
    const failed = await fetch('http://127.0.0.1:15678/webhook/hana-pool-error');
    assert.ok(failed.status >= 400); await sleep(2500); await call();
    console.log('PASS SQL failure followed by successful queued CALL');
    const logs = docker(['logs', '--no-color', 'worker']);
    const workers = new Set([...logs.matchAll(/(worker-\d+).*?(?:finished|executing|started|Executing|Start job|Job finished)/g)].map(m => m[1]));
    assert.equal(workers.size, 3, 'All three workers must execute jobs');
    console.log('PASS all three workers executed queue jobs');
    await sleep(8000);
    await admin.connect();
    const rows = (await admin.executeQuery(`SELECT CONNECTION_ID FROM SYS.M_CONNECTIONS WHERE CONNECTION_ID IN (${[...ids].map(Number).join(',')})`)).rows;
    assert.deepEqual(rows, []); console.log('PASS HANA confirms all observed worker sessions closed after idle expiry');
    const shutdownId = await call();
    docker(['restart', 'worker']); await sleep(2500);
    const shutdownRows = (await admin.executeQuery('SELECT CONNECTION_ID FROM SYS.M_CONNECTIONS WHERE CONNECTION_ID = ?', [Number(shutdownId)])).rows;
    assert.deepEqual(shutdownRows, []);
    console.log('PASS worker restart closes retained HANA session');
  } catch (error) { console.error('Queue test failed:', error.message); throw error; } finally {
    await admin.disconnect();
    if (created) {
      await sleep(2500);
      const cleanup = new HanaDataClient(credentials, { queryTimeoutMs: 15000 });
      try { await cleanup.connect(); await cleanup.executeQuery(`DROP PROCEDURE "${name}"`); }
      catch (error) { console.error(`Cleanup required for procedure ${name}`); throw error; }
      finally { await cleanup.disconnect(); }
    }
  }
}
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => main(JSON.parse(input)).catch(error => { console.error(error.message); process.exitCode = 1; }));
