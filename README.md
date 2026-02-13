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

**⚠️ Important**: This node is designed for **self-hosted n8n** installations only. It cannot be used with n8n Cloud due to dependency requirements.

### Option 1: npm Installation (Recommended)

1. Create the community nodes folder and navigate to it:
   ```bash
   mkdir -p ~/.n8n/nodes
   cd ~/.n8n/nodes
   ```
2. Install the package:
   ```bash
   test -f package.json || npm init -y
   npm install n8n-nodes-sap-hana-data@^1.0.2
   ```
3. Restart your n8n instance

### Troubleshooting: `__strdup: symbol not found`

If you see an install error like `__strdup: symbol not found` coming from `@sap/hana-client`, you are installing an older package version (≤ `1.0.1`) that depends on the native SAP driver. This fails on Alpine/musl-based n8n images.

- Use `n8n-nodes-sap-hana-data@^1.0.2` (this repo switches to the pure-JS `hdb` driver).
- If `npm` reports `No match found for version 1.0.2`, install from a local `.tgz` via Option 3B below, or switch to a glibc-based n8n image.

### Option 2: Development Setup

1. Clone this repository:
   ```bash
   git clone https://github.com/pondev1/n8n-nodes-sap-hana-data.git
   cd n8n-nodes-sap-hana-data
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the node:
   ```bash
   npm run build
   ```

4. Link the package locally:
   ```bash
   npm pack
   mkdir -p ~/.n8n/nodes
   cd ~/.n8n/nodes
   test -f package.json || npm init -y
   npm install /path/to/n8n-nodes-sap-hana-data-*.tgz
   ```

5. Restart your n8n instance

After installing the node, you can use it like any other node in n8n.

### Option 3: Docker (Manual Installation)

This option is for self-hosted n8n instances running in Docker (including Docker Compose). The key is to use a persistent volume for the n8n user folder so the installed node survives container restarts/recreates.

**Default paths (official n8n image):**
- User folder: `/home/node/.n8n` (or `$N8N_USER_FOLDER` if you override it)
- Community nodes folder: `/home/node/.n8n/nodes`

Replace `<n8n_container>` in the commands below with your container name/ID (check with `docker ps`). If you use Docker Compose, you can usually replace `docker exec`/`docker restart` with `docker compose exec n8n`/`docker compose restart n8n`.

#### 3A) Install from npm inside the running container

1. Ensure your container uses a persistent volume for `/home/node/.n8n`.
   - Docker Compose example (snippet):
     ```yaml
     services:
       n8n:
         image: n8nio/n8n:latest
         ports:
           - "5678:5678"
         volumes:
           - n8n_data:/home/node/.n8n
     volumes:
       n8n_data:
     ```

2. Open a shell inside the container:
   ```bash
   docker exec -it <n8n_container> sh
   ```

3. Inside the container, install the node:
   ```bash
   mkdir -p /home/node/.n8n/nodes
   cd /home/node/.n8n/nodes
   test -f package.json || npm init -y
   npm install n8n-nodes-sap-hana-data@^1.0.2
   exit
   ```

4. Restart n8n:
   ```bash
   docker restart <n8n_container>
   ```

#### 3B) Install from a local `.tgz` (no internet access in the container)

1. On your host machine, build and pack this repository:
   ```bash
   npm ci
   npm run build
   npm pack
   ```

2. Copy the generated tarball into the container:
   ```bash
   docker cp n8n-nodes-sap-hana-data-*.tgz <n8n_container>:/tmp/
   ```

3. Open a shell inside the container:
   ```bash
   docker exec -it <n8n_container> sh
   ```

4. Inside the container, install it and exit:
   ```bash
   mkdir -p /home/node/.n8n/nodes
   cd /home/node/.n8n/nodes
   test -f package.json || npm init -y
   npm install /tmp/n8n-nodes-sap-hana-data-*.tgz
   exit
   ```

5. Restart n8n:
   ```bash
   docker restart <n8n_container>
   ```

#### Troubleshooting (Docker)

- If you bind-mount a host folder to `/home/node/.n8n` and `npm install` fails with `EACCES`, fix the ownership/permissions of the mounted directory (the container runs as user `node`, often UID `1000`):
  ```bash
  sudo chown -R 1000:1000 ./n8n_data
  ```
- If the node does not show up after restarting, verify the install inside the container:
  ```bash
  ls -la /home/node/.n8n/nodes/node_modules/n8n-nodes-sap-hana-data
  ```

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
- Runs a custom SQL query (SELECT statements recommended)
- Supports positional parameters with `?` placeholders
- Use `LIMIT` / `OFFSET` or keyset pagination in your SQL

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

- n8n version 0.87.0 or later
- Access to SAP HANA database or HDI container
- Appropriate database permissions for SELECT operations
- Note for n8n `2.x` Docker users: newer images may be based on Alpine (musl). This package uses the pure-JS `hdb` driver to avoid native binary loading issues (for example, `__strdup: symbol not found`).

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
