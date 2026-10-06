import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class SapHanaDataApi implements ICredentialType {
  name = "sapHanaDataApi";

  displayName = "SAP HANA Data API";

  documentationUrl = "https://help.sap.com/docs/hana-cloud";

  properties: INodeProperties[] = [
    {
      displayName: "Connection Type",
      name: "connectionType",
      type: "options",
      options: [
        {
          name: "HANA Cloud HDI Container",
          value: "hdi",
          description:
            "Connect to HANA Cloud HDI Container using service key credentials",
        },
        {
          name: "HANA Database",
          value: "database",
          description:
            "Connect to regular HANA Database using direct credentials",
        },
      ],
      default: "hdi",
      description: "Type of HANA connection to establish",
    },
    {
      displayName: "Host",
      name: "host",
      type: "string",
      default: "",
      placeholder:
        "abc123def-456g-789h-ijk1-lmnopqrstuvw.hana.trial-us10.hanacloud.ondemand.com",
      description:
        "HANA server hostname (for HDI: from service key, for Database: your HANA host)",
      required: true,
    },
    {
      displayName: "Port",
      name: "port",
      type: "number",
      default: 443,
      description:
        "HANA server port (HDI: usually 443, Database: usually 30013, 30015, or 30041)",
      typeOptions: {
        minValue: 1,
        maxValue: 65535,
      },
      required: true,
    },
    {
      displayName: "Username",
      name: "username",
      type: "string",
      default: "",
      placeholder: "HDI_USER_12345678 or your-db-user",
      description:
        'Username (HDI: from service key "user" field, Database: your database username)',
      required: true,
    },
    {
      displayName: "Password",
      name: "password",
      type: "string",
      typeOptions: {
        password: true,
      },
      default: "",
      description:
        'Password (HDI: from service key "password" field, Database: your database password)',
      required: true,
    },
    {
      displayName: "Database Name",
      name: "database",
      type: "string",
      default: "",
      placeholder: "H00, HXE, or database_id from service key",
      description:
        'Database name (HDI: from service key "database_id", Database: optional)',
    },
    {
      displayName: "Schema",
      name: "currentSchema",
      type: "string",
      default: "",
      placeholder: "HDI_CONTAINER_SCHEMA or PUBLIC",
      description:
        "Schema name (HDI: your container schema from service key, Database: optional)",
    },
    {
      displayName: "Use SSL/TLS",
      name: "encrypt",
      type: "boolean",
      default: true,
      description:
        "Whether to use SSL/TLS encryption for the connection (recommended for cloud instances)",
    },
    {
      displayName: "Connection Timeout (Ms)",
      name: "connectTimeout",
      type: "number",
      default: 15000,
      description: "Connection timeout in milliseconds (15000 = 15 seconds)",
      typeOptions: {
        minValue: 1000,
        maxValue: 300000,
        numberStepSize: 1000,
      },
    },
    {
      displayName: "Validate Certificate",
      name: "validateCertificate",
      type: "boolean",
      default: true,
      description:
        "Whether to validate SSL certificates (disable only for development)",
      displayOptions: {
        show: {
          encrypt: [true],
        },
      },
    },
    {
      displayName: "Enable Connection Pooling",
      name: "pooling",
      type: "boolean",
      default: false,
      description:
        "Whether to reuse SAP native connections within each n8n worker. Requires a compatible SAP native driver environment. Custom SQL also requires Use Fresh Connection to be disabled.",
    },
    {
      displayName: "Maximum Connections Per Worker",
      name: "poolMaxConnections",
      type: "number",
      default: 5,
      typeOptions: { minValue: 1, maxValue: 50 },
      displayOptions: { show: { pooling: [true] } },
      description:
        "Maximum active and idle connections for this credential in each worker process",
    },
    {
      displayName: "Maximum Idle Connections",
      name: "poolMaxIdle",
      type: "number",
      default: 2,
      typeOptions: { minValue: 1, maxValue: 50 },
      displayOptions: { show: { pooling: [true] } },
      description:
        "Maximum retained idle connections, no greater than Maximum Connections Per Worker",
    },
    {
      displayName: "Idle Timeout (Seconds)",
      name: "poolIdleTimeout",
      type: "number",
      default: 60,
      typeOptions: { minValue: 1, maxValue: 3600 },
      displayOptions: { show: { pooling: [true] } },
      description:
        "Time before unused connections become eligible for eviction",
    },
    {
      displayName: "Pool Acquire Timeout (Ms)",
      name: "poolAcquireTimeout",
      type: "number",
      default: 10000,
      typeOptions: { minValue: 100, maxValue: 300000 },
      displayOptions: { show: { pooling: [true] } },
      description:
        "Maximum wait for a pool connection including connection establishment",
    },
    {
      displayName: "Maximum Waiting Requests",
      name: "poolMaxPending",
      type: "number",
      default: 20,
      typeOptions: { minValue: 0, maxValue: 1000 },
      displayOptions: { show: { pooling: [true] } },
      description:
        "Maximum queued requests per credential and worker when every connection is busy",
    },
    {
      displayName: "HDI Service Key Help",
      name: "hdiHelp",
      type: "notice",
      default: "",
      displayOptions: {
        show: {
          connectionType: ["hdi"],
        },
      },
      typeOptions: {
        theme: "info",
      },
      description:
        '💡 For HDI containers, get connection details from your service key JSON: Look for "credentials" section containing host, port, user, password, database_id, and schema fields',
    },
    {
      displayName: "Database Connection Help",
      name: "dbHelp",
      type: "notice",
      default: "",
      displayOptions: {
        show: {
          connectionType: ["database"],
        },
      },
      typeOptions: {
        theme: "info",
      },
      description:
        "💡 For direct database connections: Use your HANA database credentials. Ensure your user has permissions to access the required tables.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {},
  };

  // Simple test that will be handled in the node execution
  test: ICredentialTestRequest = {
    request: {
      method: "GET",
      url: "https://httpbin.org/status/200",
    },
  };
}
