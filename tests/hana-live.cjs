// Opt-in integration test. Read one credential JSON object from stdin; never save or print it.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const hdb = require('hdb');
const { HanaDataClient } = require('../dist/nodes/SapHanaData/utils/HanaConnection');
const { SapHanaData } = require('../dist/nodes/SapHanaData/SapHanaData.node');

async function main(credentials) {
  const admin = new HanaDataClient(credentials, { queryTimeoutMs: 15000 });
  const prefix = `N8N_CALL_TEST_${randomBytes(6).toString('hex').toUpperCase()}`;
  const created = [];
  const connectionIds = new Set();
  const query = (sql, values = []) => admin.executeQuery(sql, values);
  let passed = 0;
  async function check(label, fn) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fn();
    passed++;
    console.log(`PASS ${label}`);
  }
  async function create(suffix, signature, body) {
    const name = `"${prefix}_${suffix}"`;
    await query(`CREATE PROCEDURE ${name} ${signature} LANGUAGE SQLSCRIPT SQL SECURITY INVOKER READS SQL DATA AS BEGIN ${body} END`);
    created.push(['PROCEDURE', name]);
    return name;
  }
  async function execute(sql, values = [], settings = {}, inputs = 1) {
    const connections = [];
    const original = hdb.createClient;
    hdb.createClient = (options) => {
      const client = original(options);
      const record = { closed: false, connected: false };
      connections.push(record);
      client.once('close', () => { record.closed = true; });
      client.once('connect', () => {
        record.connected = true;
        client.exec('SELECT CURRENT_CONNECTION AS ID FROM DUMMY', (error, rows) => {
          if (!error) connectionIds.add(rows[0].ID);
        });
      });
      return client;
    };
    try {
      return await new SapHanaData().execute.call({
        getInputData: () => Array.from({ length: inputs }, () => ({ json: {} })),
        getCredentials: async () => {
          // Pace the integration fixture when testing through a local tunnel.
          await new Promise((resolve) => setTimeout(resolve, 2500));
          return credentials;
        },
        getNode: () => ({ name: 'HANA integration test', type: 'sapHanaData', typeVersion: 1, position: [0, 0], parameters: {} }),
        getExecutionCancelSignal: () => settings.signal,
        continueOnFail: () => settings.continueOnFail ?? false,
        getNodeParameter: (name, _index, fallback) => ({
          operation: 'customApiCall', customQuery: sql,
          queryParameters: { parameter: values.map((value) => ({ value })) },
          includeMetadata: false, returnArrayFormat: false,
          ...settings,
        }[name] ?? fallback),
      });
    } finally {
      hdb.createClient = original;
      assert.ok(connections.every((record) => !record.connected || record.closed), 'Node must await every established socket close');
    }
  }
  try {
    await admin.connect();
    const simple = await create('ROWS', '()', 'SELECT 1 AS ID FROM DUMMY;');
    const output = await create('OUTPUT', '(IN INPUT_VALUE INTEGER, OUT TOTAL INTEGER, OUT DATASET TABLE (ID INTEGER, LABEL NVARCHAR(20)))', "TOTAL := :INPUT_VALUE + 1; DATASET = SELECT :INPUT_VALUE AS ID, 'sample' AS LABEL FROM DUMMY;");
    const multi = await create('MULTI', '()', "SELECT 1 AS ID FROM DUMMY; SELECT 'second' AS LABEL FROM DUMMY;");
    const empty = await create('EMPTY', '()', 'SELECT 1 AS ID FROM DUMMY WHERE 1 = 0;');
    const scalar = await create('SCALAR', '(OUT TOTAL INTEGER)', 'TOTAL := 7;');
    const inout = await create('INOUT', '(INOUT TOTAL INTEGER)', 'TOTAL := :TOTAL + 1;');
    const failure = await create('ERROR', '()', "SIGNAL SQL_ERROR_CODE 10001 SET MESSAGE_TEXT = 'Synthetic procedure failure';");
    const table = `"${prefix}_DML"`;
    await query(`CREATE TABLE ${table} (ID INTEGER)`);
    created.push(['TABLE', table]);
    await query(`INSERT INTO ${table} VALUES (5)`);
    await admin.disconnect();
    console.log(`Created synthetic fixtures with prefix ${prefix}`);

    await check('CALL without input parameters returns its dataset', async () => {
      const [[item]] = await execute(`CALL ${simple}()`);
      assert.deepEqual(item.json, { success: true, outputParameters: {}, resultSets: [[{ ID: 1 }]], rowCount: 1 });
      assert.deepEqual(item.pairedItem, { item: 0 });
    });
    await check('CALL with IN, scalar OUT and table OUT', async () => {
      const [[item]] = await execute(`CALL ${output}(?, ?, ?)`, [41]);
      assert.equal(item.json.outputParameters.TOTAL, 42);
      assert.deepEqual(item.json.resultSets, [[{ ID: 41, LABEL: 'sample' }]]);
    });
    await check('CALL with multiple datasets preserves boundaries', async () => {
      const [[item]] = await execute(`/* leading comment */\n-- another comment\ncall ${multi}();`);
      assert.deepEqual(item.json.resultSets, [[{ ID: 1 }], [{ LABEL: 'second' }]], JSON.stringify(item.json));
    });
    await check('CALL with zero rows still emits a result', async () => {
      const [[item]] = await execute(`CALL ${empty}()`);
      assert.deepEqual(item.json.resultSets, [[]]);
      assert.equal(item.json.rowCount, 0);
    });
    await check('OUT-only procedure works with no input values', async () => {
      const [[item]] = await execute(`CALL ${scalar}(?)`);
      assert.equal(item.json.outputParameters.TOTAL, 7);
      assert.deepEqual(item.json.resultSets, []);
    });
    await check('INOUT parameter is bound and returned', async () => {
      const [[item]] = await execute(`CALL ${inout}(?)`, [9]);
      assert.equal(item.json.outputParameters.TOTAL, 10);
    });
    await check('Procedure result structure survives both output options', async () => {
      const [[item]] = await execute(`CALL ${simple}()`, [], { returnArrayFormat: true, includeMetadata: true });
      assert.deepEqual(item.json.resultSets, [[{ ID: 1 }]]);
      assert.equal(item.json.metadata.operation, 'customApiCall');
    });
    await check('Existing SELECT row and array formats are unchanged', async () => {
      const [[row]] = await execute(`SELECT ID FROM ${table} WHERE ID = ?`, [5]);
      assert.deepEqual(row.json, { ID: 5 });
      const [[array]] = await execute('SELECT 5 AS ID FROM DUMMY', [], { returnArrayFormat: true });
      assert.deepEqual(array.json.data, [{ ID: 5 }]);
    });
    await check('SQL errors preserve the original message and close the session', async () => {
      await assert.rejects(execute(`CALL ${failure}()`), /Synthetic procedure failure/);
    });
    await check('Continue-on-fail closes each session and pairs every input', async () => {
      const [items] = await execute(`CALL ${failure}()`, [], { continueOnFail: true }, 3);
      assert.equal(items.length, 3);
      items.forEach((item, index) => {
        assert.equal(item.json.success, false);
        assert.deepEqual(item.pairedItem, { item: index });
      });
    });
    await check('Repeated successful CALLs leave no node sessions behind', async () => {
      const [items] = await execute(`CALL ${simple}()`, [], {}, 20);
      assert.equal(items.length, 20);
    });
    await check('Failed schema setup disposes its connection', async () => {
      const client = new HanaDataClient({ ...credentials, currentSchema: `${prefix}_ABSENT` });
      await assert.rejects(client.connect());
      await client.disconnect();
      await assert.rejects(client.executeCustomQuery('SELECT 1 FROM DUMMY'), /not connected/);
    });
    await check('DML returns affected rows instead of disappearing', async () => {
      const [[item]] = await execute(`INSERT INTO ${table} VALUES (?)`, [1]);
      assert.ok(item.json.affectedRows === 1 || JSON.stringify(item.json.affectedRows) === '[1]');
    });
    await admin.connect();
    await check('HANA has released all node sessions', async () => {
      for (const id of connectionIds) {
        const result = await query('SELECT COUNT(*) AS N FROM SYS.M_CONNECTIONS WHERE CONNECTION_ID = ?', [id]);
        assert.equal(Number(result.rows[0].N), 0);
      }
    });
    console.log(`${passed} live checks passed, including node execute() and server-side connection disposal.`);
  } catch (error) {
    console.error('Live test failed:', error.message);
    throw error;
  } finally {
    const errors = [];
    // A test may deliberately destroy a transport. Use a fresh connection for object cleanup.
    await admin.disconnect().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await admin.connect();
    for (const [type, name] of created.reverse()) {
      try { await query(`DROP ${type} ${name}`); }
      catch (error) { errors.push(new Error(`Could not remove test object ${name}: ${error.message}`)); }
    }
    await admin.disconnect();
    if (errors.length) throw new AggregateError(errors, 'Test object cleanup failed');
    console.log('All created test objects removed; observer connection closed.');
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  Promise.resolve().then(() => main(JSON.parse(input))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
