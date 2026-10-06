# n8n-nodes-sap-hana-data

This is an n8n community node for reading data from SAP HANA databases and HDI containers.

## Features

- Connect to SAP HANA Cloud HDI containers
- Connect to regular SAP HANA databases
- Read all records from tables
- Filter records with WHERE conditions
- Specify columns to retrieve
- Sort and limit results
- Flexible output formats

## Installation

This fork's package name is **`n8n-nodes-sap-hana-2`**, currently version **1.0.3**.
The changes described here are in Git; pushing this repository does **not** publish
an npm release. Install the tarball built from this checkout to get these fixes.
Do not substitute the older `n8n-nodes-sap-hana-data` registry package.

### Build the installable package

Use Node.js 22 and npm on a build machine:

```bash
git clone https://github.com/vedantshukla2009/n8n-nodes-sap-hana-data.git
cd n8n-nodes-sap-hana-data
npm ci
npm test
npm run lint
npm pack --ignore-scripts
```

This produces `n8n-nodes-sap-hana-2-1.0.3.tgz`. Dependencies still need registry
access during installation; a tarball alone is not an offline dependency bundle.

For a non-Docker installation, install it in the n8n service account's user folder:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install --omit=dev /absolute/path/n8n-nodes-sap-hana-2-1.0.3.tgz
```

Restart every n8n process that executes this node. Native pooling requires a supported
platform; Linux x64 and Windows x64 were tested.

### Remote Docker Compose: main plus three workers

These instructions assume services `n8n` and `n8n-worker` share the same persistent
volume at `/home/node/.n8n`, as in a PostgreSQL/Redis queue-mode deployment. Back up
that volume, PostgreSQL and the existing encryption key before updating. Schedule
a short maintenance window so running workflows can finish.

1. Copy the tarball to your remote Compose directory. Clone this repository on the
   remote host too, so `docker/Dockerfile` is available.
2. Build the SAP-compatible n8n base image from the repository directory:

   ```bash
   docker build -f docker/Dockerfile --build-arg N8N_VERSION=2.29.8 -t n8n-hana:2.29.8 .
   ```

   This image restores the `ldd` entry needed for SAP's Linux musl binary detection.
   It does not install the community package or replace your n8n data.
3. In your existing Compose file, change the shared `x-shared` image to
   `n8n-hana:2.29.8` and add `pull_policy: never`. Retain the database, Redis,
   volumes, encryption key, URLs and other existing settings. The obsolete top-level
   `version` field can be removed. Pin a tested n8n version instead of `stable`.
4. From the remote Compose directory, install once into the shared volume using
   a temporary Node container. This also works when the n8n image has no npm/shell:

   ```bash
   n8n_container=$(docker compose ps -q n8n)
   test -n "$n8n_container" || exit 1
   docker compose stop n8n n8n-worker
   docker run --rm --user 1000:1000 \
     --volumes-from "$n8n_container" \
     -v "$PWD:/package:ro" \
     node:22-alpine sh -ec '
       mkdir -p /home/node/.n8n/nodes
       cd /home/node/.n8n/nodes
       cp /package/n8n-nodes-sap-hana-2-1.0.3.tgz .
       npm install --omit=dev --ignore-scripts ./n8n-nodes-sap-hana-2-1.0.3.tgz
     '
   ```

   Check that installation succeeds before continuing. Use your n8n service UID/GID
   if it differs from 1000. The installer needs registry access. `--ignore-scripts`
   uses the driver's packaged binaries; verify that the native module loads below.
5. Recreate main and all three workers with the new image, preserving the volumes:

   ```bash
   docker compose up -d --scale n8n-worker=3 n8n n8n-worker
   docker compose ps
   docker compose exec n8n node -e "console.log(require('/home/node/.n8n/nodes/node_modules/n8n-nodes-sap-hana-2/package.json').version)"
   docker compose exec --index 1 n8n-worker node -e "const {createRequire}=require('module');const r=createRequire('/home/node/.n8n/nodes/node_modules/n8n-nodes-sap-hana-2/package.json');console.log(r('@sap/hana-client').getDriverVersion())"
   ```

   Repeat the native-driver check with `--index 2` and `--index 3`. Do not use
   `docker compose down -v`: that would delete persistent data.
6. Enable **Connection Pooling** in the SAP HANA credential. For stateless custom
   SQL/CALL, also turn off **Use Fresh Connection** on the node. Test with
   `SELECT CURRENT_CONNECTION AS CONNECTION_ID FROM DUMMY;` and a known procedure.

Keep the normal node type `n8n-nodes-sap-hana-2.sapHanaData`; do not deploy the test
image's `CUSTOM` registration. If older workflows reference a different package name,
they need a deliberate migration; installing this fork does not rename their node types.

The HANA host must be reachable from **every worker container**. Container `127.0.0.1`
is the container itself. Docker Desktop supports `host.docker.internal`; on Linux,
a host-gateway mapping alone does not make a tunnel bound only to host loopback reachable.
Use an appropriately secured, container-reachable tunnel listener or database endpoint.

## Configuration

### Credentials

1. Create new credentials of type "SAP HANA API"
2. Choose connection type:
   - **HDI Container**: Use service key credentials from SAP BTP
   - **Database**: Use direct database connection details
3. Fill in the connection details:
   - **Host**: Database hostname (from service key "host" field)
   - **Port**: Database port (from service key "port" field, typically 443 for HANA Cloud)
   - **Username**: Database username (from service key "user" field)
     - Use **_DT** suffix user for design-time operations (creating/modifying database objects)
     - Use **_RT** suffix user for runtime operations (reading data, SELECT queries) - **Recommended for this node**
   - **Password**: Database password (from service key "password" field)
   - **Database**: Database name (from service key "database" field, optional)
   - **Schema**: Schema name (from service key "schema" field or your specific schema) 

### Node Usage

1. Add "SAP HANA Data" node to your workflow
2. Select your credentials
3. Choose operation:
   - **Get All Records**: Retrieve all records from a table
   - **Get Records with Filter**: Retrieve records with WHERE conditions
   - **Custom API Call (Custom SQL Query)**: Run a custom SQL query with optional parameters
4. Configure table name and options
5. Execute the node

## Operations

### Get All Records
- Retrieves all records from specified table
- Optional column selection
- Optional sorting and limiting

### Get Records with Filter
- Retrieves records matching WHERE condition
- All features from "Get All Records"
- Flexible WHERE clause support

### Custom API Call (Custom SQL Query)
- Runs a custom SQL statement, including `SELECT` and `CALL`
- Supports positional parameters with `?` placeholders
- Use `LIMIT` / `OFFSET` or keyset pagination in your SQL

### Stored procedures

Use **Custom API Call** with a schema-qualified call, for example:

```sql
CALL "MY_SCHEMA"."MY_PROCEDURE"(?, ?, ?)
```

If the signature is `(IN INPUT_VALUE INTEGER, OUT TOTAL INTEGER, OUT DATASET TABLE (...))`,
add **one** Query Parameter for `INPUT_VALUE`. Include placeholders for OUT arguments in
the SQL, but do not add values for them. INOUT arguments require an input value.
Calls without inputs, including `CALL "MY_SCHEMA"."MY_PROCEDURE"()`, are supported.

Each CALL produces one n8n item per input item:

```json
{
  "success": true,
  "outputParameters": { "TOTAL": 42 },
  "resultSets": [[{ "ID": 41, "LABEL": "sample" }]],
  "rowCount": 1
}
```

`resultSets` preserves the order and boundaries of all returned datasets, including
empty datasets. `rowCount` sums their rows. Scalar outputs are in `outputParameters`.
The **Return Array Format** setting applies to SELECT results; CALL always uses the
structure above. **Include Metadata** optionally adds a `metadata` property. Existing
SELECT output and input-item pairing are preserved. Use n8n's Split Out node on
`resultSets[0]` when subsequent nodes need one item per row of the first dataset.
The database user needs EXECUTE permission on the procedure.

DML returns an item with `success` and `affectedRows` (a count or an array of counts
provided by the driver). Statements without results return `{ "success": true }`.

### Connection lifetime and disposal

With pooling disabled (the default), this release uses `hdb`. Each input item opens its own
connection. Prepared statements are disposed before physical disconnection, and node
execution awaits socket closure. Cleanup runs after success and failure, with a
5-second graceful-close deadline followed by forced termination and a bounded wait
for confirmation. A failed connection attempt also aborts its pending transport.

**Query Timeout (Seconds)** optionally limits preparation and execution of each SQL
statement. The default, `0`, preserves the existing behavior without a query deadline.
A timeout or an n8n execution cancellation closes the connection. SQL is never
automatically retried. Keepalive is not a substitute for this timeout. The connection
timeout remains a separate credential setting. Killing a worker abruptly cannot run
JavaScript cleanup; database/network timeout behavior then determines server cleanup.

Enable **Connection Pooling** in the credential to use the pinned `@sap/hana-client`
explicit pool. Pools are process-local and isolated by n8n credential ID and a private
digest of credential/configuration values. Connections are leased exclusively for one
input item and returned only after results and statement cleanup finish.

| Setting | Default | Scope |
| --- | --- | --- |
| Maximum connections | 5 | Active + idle, per credential per worker |
| Maximum idle connections | 2 | Per pool |
| Idle timeout | 60 seconds | Eligibility for native eviction; wholly idle pools are explicitly cleared |
| Acquire timeout | 10 seconds | Queueing plus native acquisition |
| Maximum waiting requests | 20 | Per pool; overflow fails immediately |

With three workers, one credential can use up to **15 pooled HANA sessions**, with at
most six retained idle. Main-process/manual executions, fresh connections, and overlapping
deployments add to that count. There is no cluster-wide pool. An actively reused connection
can live for hours; 60 seconds is an idle limit, not a maximum connection age. The registry
is bounded to 20 pools per process; exhausted or unconfirmed cleanup capacity fails closed.

**Custom SQL and CALL default to Use Fresh Connection.** Disable that node option to pool
procedures/queries you know do not leave temporary objects or persistent session state.
SAP resets transactions and client information on release, and this node explicitly restores
the credential schema (or authenticated user's schema) on each checkout. Temporary tables
are not removed by SAP's reset, so stateful procedures should retain fresh connections.
This setting is deliberately separate from the credential pooling switch.

Viability checks are enabled and user switching is disabled. Unknown SQL, cancellation, and cleanup
failures retire the affected pool; queued requests fail and active leases finish before the
pool is cleared. No borrower can reuse a possibly contaminated connection. Credential changes
also retire the previous pool; new requests fail while old leases are draining, rather than
exceeding the configured limit. Late native acquisition callbacks are disposed even when the
request has already timed out. SQL is not automatically retried.

Recognized SQL errors (257, 258, 259, 260 and 301: syntax, permissions, missing
table/column and unique constraint errors) keep the pool available when statement
cleanup and session release succeed. Cleanup errors still retire that pool.
Completed disconnect/clear failures receive up to three serialized attempts, with
100 ms and 500 ms backoff. A reporting timeout never starts another native call
while the previous call is pending. Failed clears are not permanently cached:
a later acquisition can initiate another bounded cleanup attempt.
If all disconnect attempts fail, the connection remains accounted for and quarantined;
subsequent requests explicitly report that this worker needs restarting. We cannot
safely forget a native connection whose release is unconfirmed.

Cleanup warnings include the phase, process ID and numeric error code, without native
messages, SQL or credentials. Pool cleanup attempts also identify the process-local
pool number. Set `HANA_POOL_DEBUG=true` on workers to log pool-clear start/success
events when correlating idle eviction with tunnel logs. This does not prove whether
the underlying TCP close used FIN or RST.
`tests/pool-disposal-live.cjs` verifies retry behavior before and after a real native
release using injected callback failures and read-only sessions; credentials enter via stdin.

Release has a five-second reporting deadline. If a native request has not finished, its lease
stays quarantined and cleanup continues when its callback arrives. The connection is never
returned early. No community-node SIGTERM handler overrides n8n's shutdown. Idle eviction,
native driver teardown and OS socket closure handle process exit; abrupt host/network failure
can delay server-side detection. See [SAP explicit pooling](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/c375e7ea12da48388b0f6c7aa4743044.html).

### Docker deployment and queue-mode tests

For interactive local testing, `docker/local/compose.yml` runs n8n 2.29.8 with three
workers at **http://localhost:15678**. Unlike the automated test stack, it uses persistent
Docker volumes. The local package is installed under its normal community-node name,
`n8n-nodes-sap-hana-2.sapHanaData`, and is shared by main and workers.
The first visit asks you to create your own local owner account. Search for **SAP HANA Data**
in the node picker. Use `host.docker.internal:30015` for a tunnel on your Docker Desktop host.

From the repository root, stop or resume this environment with:

```powershell
docker compose --env-file docker/local/.env -f docker/local/compose.yml stop
docker compose --env-file docker/local/.env -f docker/local/compose.yml up -d
```

The ignored `docker/local/.env` contains generated local database/encryption secrets.
Keep it with the persistent volumes: changing the encryption key prevents existing
credentials from being decrypted. Do not use `down -v` unless you intend to erase local data.
After changing node code, run `npm run build`, stop the local stack, then run the same
Compose `up -d` command with `--build --force-recreate` to refresh the installed package.

Use the same built package/image on the main instance and every worker. Pin the n8n version
instead of using a moving `stable` tag. The public `n8n-workflow` peer range supports major
versions 1 and 2; future major versions require validation before extending it.

For an existing community-package deployment, build `docker/Dockerfile` with the desired
`N8N_VERSION` and use that image in your shared Compose configuration. Install the new `.tgz`
in the existing shared n8n user directory and restart main and all workers. This preserves
the community node's existing workflow type name. Do not switch existing workflows to the
test image's `CUSTOM` node registration.

```powershell
npm run build
npm pack --ignore-scripts
docker build -f docker/Dockerfile --build-arg N8N_VERSION=2.29.8 -t n8n-hana:2.29.8 .
```

The SAP driver is an optional installation dependency so unsupported platforms can still
use the non-pooled mode. Enabling pooling without a loadable native driver produces an
explicit configuration error; it never silently falls back or retries the operation.

`tests/docker/Dockerfile` builds an image with the compiled node and production dependencies.
It also restores `ldd` for hardened Alpine x64 images: SAP's driver uses that command to select
its musl binary. Without it, native loading may fail with `__strdup: symbol not found`.
This image uses a custom extension directory; avoid also installing a duplicate community
package in that image. Native pooling is tested on Linux x64 and Windows x64, not Alpine ARM.
Disabling pooling keeps the pure-JavaScript driver path.

The isolated test Compose file uses PostgreSQL 16, Redis 6, one main and three workers, with
the editor bound to `127.0.0.1:15678`. Its database is disposable and its example passwords
must not be used for production. Workers wait for main readiness so initial migrations finish.

```powershell
npm run build
$env:N8N_VERSION = '2.29.8' # Repeat on 2.41.7 in a fresh test stack
docker compose -f tests/docker/compose.yml up -d --build --scale worker=3
Get-Content -Raw C:\private\hana-test.json | node tests/docker/queue-live.cjs
docker compose -f tests/docker/compose.yml down
```

The harness imports synthetic credentials/workflows into this isolated stack, invokes production
webhooks, checks all three workers execute jobs, and verifies observed HANA sessions disappear
after idle expiry. HANA credentials are supplied through stdin, stored encrypted by n8n and
removed with the disposable test database. Temporary plaintext import files are deleted immediately.
The test assumes the HANA tunnel is on the Docker Desktop host (`host.docker.internal`).
It creates/drops uniquely named test procedures. A tunnel outage can fail the run; the harness
paces bursts and does not retry SQL. It is a correctness test, not a sustained-load benchmark.

### Regression tests

Initial integration validation on 2026-10-06: 36 automated tests; live native CALL/session/transaction/network
checks; and real queue-mode workflows on n8n **2.29.8** and **2.41.7**, each with three
workers. The successful queue runs included 12 sequential calls reusing three sessions,
36 calls in concurrent bursts, fresh connections, SQL-error recovery and server-confirmed
idle disposal. Worker-restart disposal was also verified on 2.41.7. Some earlier runs failed
with tunnel resets/timeouts; the completed runs used paced bursts. These results do not
establish sustained production throughput or compatibility with untested future releases.

After disposal hardening, **42 automated tests passed**, including settled disconnect
recovery, permanent-failure quarantine, failed-clear recovery, late callbacks and SQL-error
pool reuse. Build passed; lint reported only two existing `no-explicit-any` warnings in
node input/output declarations. The updated live HANA suite passed inside each of the
three local n8n 2.29.8 worker containers. These latest runs invoked the driver harness in
the containers; they did not repeat the earlier full webhook queue suite on both versions.
Native disposal fault-injection tests passed on Windows x64 and Linux x64, including
failures injected before and after real native release. This is evidence for those
tested paths, not a guarantee for every possible native-driver failure.

### Work completed and remaining investigations (2026-10-06)

- Fixed prepared CALL execution, scalar/INOUT outputs, multiple datasets, empty datasets
  and native column-metadata separation. SELECT and affected-row responses remain distinct.
- Added bounded statement/connection disposal, cancellation and query deadlines to the
  dedicated hdb path, including stalled TCP/TLS handshakes and primary-error preservation.
- Added opt-in SAP native pooling per worker and credential, bounded queues, credential
  rotation isolation, session reset, explicit schema restoration and fresh-connection override.
- Hardened failed release/clear handling and added sanitized cleanup diagnostics. No SQL retry
  was introduced. Permanent unconfirmed disconnects require a worker restart.
- Added automated mocks, live HANA tests, an isolated queue-mode Docker test stack, a
  production base-image adjustment, and a persistent local n8n stack with three workers.
  The local installer replaces only this package directory when refreshing it.
- Updated the optional native dependency and n8n-workflow peer compatibility range. Future
  n8n major releases and untested native platforms still need validation.

The tunnel repeatedly reports a TCP reset near the configured 60-second idle eviction.
That timing strongly implicates idle closure, but the sender and cause of the reset are
**unverified**. Successful cleanup and disappearing HANA sessions do not prove a graceful
TCP FIN exchange. Comparing direct native disconnect, native pool clear and wrapper eviction
with a capture on the HANA-facing tunnel connection remains deferred. Increasing the idle
timeout would change timing, not establish or fix the cause. Investigation is paused.

The existing credential test still checks a placeholder HTTP endpoint rather than HANA.
A green credential-test banner is therefore **not evidence of database connectivity**;
validate with an actual SELECT from the execution environment. Replacing that test remains
outstanding. No npm publication or remote production deployment was performed as part of
this work; installation uses the locally built tarball.

Run `npm test` for driver-independent result/cleanup tests, including real local sockets
that stall during HANA and TLS handshakes. Run `npm run lint` for the lint gate.

`tests/pool-live.cjs` verifies native reuse, scalar/INOUT/multiple/empty CALL results,
schema/client-info reset, idle eviction, real lock-wait cancellation and transaction rollback.
`tests/pool-network-live.cjs` drops a test-owned proxy socket to verify stale idle connection
replacement without interrupting the user's tunnel. Both accept the same credential JSON
on stdin. The native driver is pinned because its procedure callback contract includes
column metadata after the data tables.

The opt-in `tests/hana-live.cjs` test invokes the node's actual `execute()` method against
HANA using a minimal n8n execution context. It creates uniquely named synthetic procedures
and a test table, verifies result formats and server-side session disposal, and drops only
its own objects. This is not a replacement for importing a workflow into your deployed n8n.
The test account needs privileges to create/drop those objects and read `SYS.M_CONNECTIONS`.
Provide a credential JSON file **outside the repository** using the credential field names
`host`, `port`, `username`, `password`, `encrypt`, and optionally `currentSchema`.

```powershell
npm run build
Get-Content -Raw C:\private\hana-test.json | node tests/hana-live.cjs
```

The script reads credentials from stdin and does not save or print them. If the endpoint
goes offline during cleanup, the script reports the unique test-object prefix for manual
cleanup once access returns. Never commit real credentials or test database exports.

## Examples

### Basic Usage
```
Table Name: CUSTOMERS
Limit: 100
```

### With Filtering
```
Table Name: ORDERS
WHERE Condition: STATUS = 'COMPLETED' AND ORDER_DATE > '2024-01-01'
Limit: 50
```

### Custom Columns
```
Table Name: PRODUCTS
Columns: ID, NAME, PRICE, CATEGORY
Order By: PRICE DESC
```

### Custom SQL with Pagination
```
SQL Query: SELECT * FROM "SBO_TUEMPRESA"."JDT1" WHERE "TransId" > {{ $json.last_trans_id }} ORDER BY "TransId", "Line_ID" LIMIT {{ $json.batch_size }}
```

### Custom SQL with Parameters
```
SQL Query: SELECT * FROM "SBO_TUEMPRESA"."JDT1" WHERE "TransId" > ? ORDER BY "TransId", "Line_ID" LIMIT ?
Query Parameters: 1000, 500
```

## Requirements

- n8n with `n8n-workflow` major 1 or 2 (queue-mode integration targets: 2.29.8 and 2.41.7)
- Access to SAP HANA database or HDI container
- Appropriate database permissions for SELECT operations
- Pooling requires a compatible SAP native driver environment; the default non-pooled mode uses pure-JavaScript `hdb`.

## Sample Workflows

Ready-to-use n8n workflow examples are available in the `workflows/` directory:

### 1. Get Data from SAP HANA DB Tables Workflow
**File**: [`workflows/Get Data from SAP Hana DB tables.json`](./workflows/Get%20Data%20from%20SAP%20Hana%20DB%20tables.json)

Comprehensive workflow demonstrating data retrieval from SAP HANA database tables with various query options and data processing capabilities.

**Features**:
- Table data retrieval with filtering
- Column selection and sorting
- Result limiting and pagination
- Data transformation and processing
- Error handling and validation

### How to Use Sample Workflows

1. Download the desired workflow JSON file
2. In n8n, go to **Workflows** > **Import from File**
3. Select the downloaded JSON file
4. Configure your SAP HANA credentials (use _RT user for read operations)
5. Update table names to match your database schema
6. Customize WHERE conditions and column names as needed
7. Activate and test the workflow

## Support

For issues and feature requests, please create an issue in the GitHub repository.

## License

MIT License
