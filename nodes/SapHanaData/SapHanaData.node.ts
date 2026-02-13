import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { HanaDataClient } from './utils/HanaConnection';

const parseQueryParameterValue = (value: unknown): unknown => {
	if (value === null || value === undefined) return value;
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
};

export class SapHanaData implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SAP HANA Data',
		name: 'sapHanaData',
		icon: 'file:saphana.svg',
		group: ['input'],
		version: 1,
		subtitle:
			'={{$parameter["operation"] + ($parameter["tableName"] ? ": " + $parameter["tableName"] : "")}}',
		description: 'Read data from SAP HANA tables and HDI containers',
		defaults: {
			name: 'SAP HANA Data',
		},
		inputs: ['main'] as any,
		outputs: ['main'] as any,
		usableAsTool: true,
		credentials: [
			{
				name: 'sapHanaDataApi',
				required: true,
			},
		],
		properties: [
			// Operation selection
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Retrieve many records from a table',
						action: 'Get many records from table',
					},
					{
						name: 'Get Records with Filter',
						value: 'getFiltered',
						description: 'Retrieve records with WHERE conditions',
						action: 'Get filtered records from table',
					},
					{
						name: 'Custom API Call',
						value: 'customApiCall',
						description: 'Run a custom SQL query with parameters and pagination',
						action: 'Run a custom SQL query',
					},
				],
				default: 'getAll',
			},

			// Table name field
			{
				displayName: 'Table Name',
				name: 'tableName',
				type: 'string',
				default: '',
				placeholder: 'e.g., CUSTOMERS',
				required: true,
				displayOptions: {
					show: {
						operation: ['getAll', 'getFiltered'],
					},
				},
			},

			// Limit field
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 0,
				placeholder: '0 for no limit',
				description: 'Maximum number of records to return (0 for no limit)',
				typeOptions: {
					minValue: 0,
					maxValue: 100000,
				},
				displayOptions: {
					show: {
						operation: ['getAll', 'getFiltered'],
					},
				},
			},

			{
				displayName: 'Include Metadata',
				name: 'includeMetadata',
				type: 'boolean',
				default: true,
				description: 'Whether to include query metadata in the output',
			},

			{
				displayName: 'Return Array Format',
				name: 'returnArrayFormat',
				type: 'boolean',
				default: false,
				description: 'Whether to return all rows as a single item with a data array',
			},

			// WHERE condition for filtered queries
			{
				displayName: 'WHERE Condition',
				name: 'whereCondition',
				type: 'string',
				default: '',
				placeholder: 'e.g., STATUS = \'ACTIVE\' AND CREATED_DATE > \'2024-01-01\'',
				description: 'WHERE clause condition (without the WHERE keyword)',
				displayOptions: {
					show: {
						operation: ['getFiltered'],
					},
				},
				required: true,
			},

			{
				displayName: 'SQL Query',
				name: 'customQuery',
				type: 'string',
				default: '',
				placeholder: 'SELECT * FROM "SBO_TUEMPRESA"."JDT1" WHERE "TransId" > ? ORDER BY "TransId", "Line_ID" LIMIT ?',
				description:
					'SQL query to execute. Use ? placeholders for parameters and add LIMIT or OFFSET for pagination.',
				displayOptions: {
					show: {
						operation: ['customApiCall'],
					},
				},
				required: true,
			},

			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'fixedCollection',
				placeholder: 'Add Parameter',
				default: {},
				typeOptions: {
					multipleValues: true,
				},
				description: 'Parameters for ? placeholders in the query, in order',
				displayOptions: {
					show: {
						operation: ['customApiCall'],
					},
				},
				options: [
					{
						displayName: 'Parameter',
						name: 'parameter',
						values: [
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: 'e.g., 123 or "ACTIVE"',
								description:
									'Parameter value. JSON is supported for numbers, booleans, null, arrays, or objects.',
							},
						],
					},
				],
			},

			// Options section
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['getAll', 'getFiltered'],
					},
				},
				options: [
					{
						displayName: 'Columns',
						name: 'columns',
						type: 'string',
						default: '*',
						placeholder: 'e.g., ID, NAME, EMAIL or * for all columns',
						description: 'Comma-separated list of columns to retrieve, or * for all columns',
					},
					{
						displayName: 'Order By',
						name: 'orderBy',
						type: 'string',
						default: '',
						placeholder: 'e.g., CREATED_DATE DESC, NAME ASC',
						description: 'ORDER BY clause (without the ORDER BY keyword)',
					},
				],
			},

			// Help notice
			{
				displayName: 'SAP HANA Connection Info',
				name: 'hanaNotice',
				type: 'notice',
				default: '',
				typeOptions: {
					theme: 'info',
				},
				description: '💡 Ensure your HANA user has SELECT permissions on the target tables. For HDI containers, use the schema from your service key.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Validate input items
		if (!items || items.length === 0) {
			throw new NodeOperationError(this.getNode(), 'No input data provided');
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const credentials = await this.getCredentials('sapHanaDataApi');
				const includeMetadata = this.getNodeParameter('includeMetadata', i, true) as boolean;
				const returnArrayFormat = this.getNodeParameter('returnArrayFormat', i, false) as boolean;

				const client = new HanaDataClient(credentials);

				let results: any[] = [];
				let queryInfo: any = {};

				try {
					// Connect to HANA
					await client.connect();

					// Execute based on operation
					switch (operation) {
						case 'getAll': {
							const tableName = this.getNodeParameter('tableName', i) as string;
							const limit = this.getNodeParameter('limit', i, 0) as number;
							const options = this.getNodeParameter('options', i, {}) as {
								columns?: string;
								orderBy?: string;
							};

							const columns = options.columns || '*';
							const orderBy = options.orderBy || '';

							if (orderBy || limit > 0) {
								results = await client.getFilteredRecords(
									tableName, 
									'1=1', // Always true condition
									columns, 
									orderBy || undefined, 
									limit > 0 ? limit : undefined
								);
							} else {
								results = await client.getAllRecords(tableName, columns);
							}

							queryInfo = {
								operation: 'getAll',
								tableName,
								columns,
								orderBy,
								limit: limit > 0 ? limit : null,
							};
							break;
						}

						case 'getFiltered': {
							const tableName = this.getNodeParameter('tableName', i) as string;
							const limit = this.getNodeParameter('limit', i, 0) as number;
							const options = this.getNodeParameter('options', i, {}) as {
								columns?: string;
								orderBy?: string;
							};
							const columns = options.columns || '*';
							const orderBy = options.orderBy || '';
							const whereCondition = this.getNodeParameter('whereCondition', i) as string;

							results = await client.getFilteredRecords(
								tableName,
								whereCondition,
								columns,
								orderBy || undefined,
								limit > 0 ? limit : undefined
							);

							queryInfo = {
								operation: 'getFiltered',
								tableName,
								whereCondition,
								columns,
								orderBy,
								limit: limit > 0 ? limit : null,
							};
							break;
						}

						case 'customApiCall': {
							const query = this.getNodeParameter('customQuery', i) as string;
							if (!query.trim()) {
								throw new NodeOperationError(this.getNode(), 'SQL query is required', { itemIndex: i });
							}

							const queryParameters = this.getNodeParameter('queryParameters', i, {}) as {
								parameter?: Array<{ value: unknown }>;
							};
							const params = (queryParameters.parameter ?? []).map((param) =>
								parseQueryParameterValue(param.value),
							);

							results = await client.executeCustomQuery(query, params);

							queryInfo = {
								operation: 'customApiCall',
								query,
								parameterCount: params.length || null,
							};
							break;
						}

						default:
							throw new NodeOperationError(
								this.getNode(),
								`Unknown operation: ${operation}`,
								{ itemIndex: i }
							);
					}

					// Format output based on options
					if (returnArrayFormat) {
						// Return as single item with array
						const outputItem: INodeExecutionData = {
							json: {
								success: true,
								timestamp: new Date().toISOString(),
								...queryInfo,
								rowCount: results.length,
								data: results,
							},
							pairedItem: { item: i },
						};

						if (includeMetadata) {
							outputItem.json.metadata = {
								...queryInfo,
								totalRows: results.length,
								timestamp: new Date().toISOString(),
							};
						}

						returnData.push(outputItem);
					} else {
						// Return each row as separate item
						if (results.length === 0) {
							// Return empty result info if no data found
							returnData.push({
								json: {
									success: true,
									timestamp: new Date().toISOString(),
									...queryInfo,
									rowCount: 0,
									message: 'No records found',
								},
								pairedItem: { item: i },
							});
						} else {
							// Add metadata to first item if requested
							for (let j = 0; j < results.length; j++) {
								const outputItem: INodeExecutionData = {
									json: results[j],
									pairedItem: { item: i },
								};

								// Add metadata to first item
								if (j === 0 && includeMetadata) {
									outputItem.json._metadata = {
										...queryInfo,
										totalRows: results.length,
										timestamp: new Date().toISOString(),
									};
								}

								returnData.push(outputItem);
							}
						}
					}

				} finally {
					// Always disconnect
					await client.disconnect();
				}

			} catch (error: any) {
				if (this.continueOnFail()) {
					const errorResult: INodeExecutionData = {
						json: {
							error: {
								message: error.message,
								type: error.constructor.name,
								itemIndex: i,
							},
							success: false,
							timestamp: new Date().toISOString(),
						},
						pairedItem: { item: i },
					};
					returnData.push(errorResult);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`SAP HANA Read operation failed: ${error.message}`,
						{ itemIndex: i }
					);
				}
			}
		}

		return [returnData];
	}
}
