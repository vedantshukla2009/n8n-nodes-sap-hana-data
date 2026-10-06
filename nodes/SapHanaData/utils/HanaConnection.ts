import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import hdb, { Client, ExecutionCallback, Statement } from 'hdb';

interface HanaProcedureResult {
	kind: 'procedure';
	outputParameters: IDataObject;
	resultSets: IDataObject[][];
}

export type HanaQueryResult =
	| { kind: 'rows'; rows: IDataObject[] }
	| HanaProcedureResult
	| { kind: 'statement'; affectedRows?: number | number[] };

export interface ExecutionOptions {
	signal?: AbortSignal;
	queryTimeoutMs?: number;
	cleanupTimeoutMs?: number;
}

interface Session {
	client: Client;
	controller: AbortController;
	closed: Promise<void>;
	connectFinished: Promise<void>;
	expectClose: boolean;
	removeCancellationListener: () => void;
}

function asError(error: unknown, prefix?: string): Error {
	const cause = error instanceof Error ? error : new Error(String(error));
	if (!prefix) return cause;
	return Object.assign(new Error(`${prefix}: ${cause.message}`), {
		cause,
		code: (cause as Error & { code?: string | number }).code,
	});
}

export function normalizeResult(result: unknown, resultSets: unknown[]): HanaQueryResult {
	if (Array.isArray(result)) {
		if (result.length > 0 && result.every((value) => typeof value === 'number')) {
			return { kind: 'statement', affectedRows: result as number[] };
		}
		return { kind: 'rows', rows: result as IDataObject[] };
	}
	if (result !== null && typeof result === 'object') {
		if (!resultSets.every(Array.isArray)) throw new Error('Unexpected HANA procedure result set');
		return {
			kind: 'procedure',
			outputParameters: result as IDataObject,
			resultSets: resultSets as IDataObject[][],
		};
	}
	if (typeof result === 'number') return { kind: 'statement', affectedRows: result };
	if (result === undefined || result === null) return { kind: 'statement' };
	throw new Error('Unexpected HANA execution result');
}

export class HanaDataClient {
	private session?: Session;
	private closing?: Promise<void>;
	private readonly cleanupTimeoutMs: number;

	constructor(
		private readonly credentials: ICredentialDataDecryptedObject,
		private readonly options: ExecutionOptions = {},
	) {
		this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
	}

	async connect(): Promise<void> {
		if (this.session || this.closing) throw new Error('HANA client is already open or closing');
		if (this.options.signal?.aborted) throw new Error('HANA execution cancelled');
		const controller = new AbortController();
		const connectTimeoutMs = (this.credentials.connectTimeout as number) || 15000;
		const client = hdb.createClient({
			host: this.credentials.host as string,
			port: this.credentials.port as number,
			user: this.credentials.username as string,
			password: this.credentials.password as string,
			databaseName: (this.credentials.database as string) || undefined,
			useTLS: (this.credentials.encrypt as boolean) ?? true,
			rejectUnauthorized: (this.credentials.validateCertificate as boolean) ?? true,
			initializationTimeout: connectTimeoutMs,
			// hdb forwards this to net/tls.connect: abort also covers sockets not yet authenticated.
			signal: controller.signal,
		});
		let finishConnect!: () => void;
		const session: Session = {
			client,
			controller,
			closed: new Promise<void>((resolve) => client.once('close', resolve)),
			connectFinished: new Promise<void>((resolve) => {
				finishConnect = resolve;
			}),
			expectClose: false,
			removeCancellationListener: () => this.options.signal?.removeEventListener('abort', cancel),
		};
		const cancel = () => this.abort(session, new Error('HANA execution cancelled'));
		this.session = session;
		this.options.signal?.addEventListener('abort', cancel, { once: true });
		// Keep a listener for errors between operations and during disposal, without logging SQL or secrets.
		client.on('error', (error: unknown) => this.abort(session, asError(error)));
		try {
			await this.run<void>(
				session,
				(done) => {
					try {
						client.connect((error) => {
							session.expectClose ||= ['connecting', 'connected', 'disconnected'].includes(
								client.readyState,
							);
							finishConnect();
							if (controller.signal.aborted) client.destroy();
							done(error ? asError(error, 'HANA connection failed') : undefined);
						});
					} catch (error) {
						finishConnect();
						done(error);
					}
				},
				connectTimeoutMs,
				'HANA connection timed out',
			);
			if (this.credentials.currentSchema) {
				const schema = String(this.credentials.currentSchema);
				// Preserve explicitly quoted schemas and the existing unquoted identifier semantics.
				const identifier = /^"(?:[^"]|"")+"$/.test(schema)
					? schema
					: `"${schema.toUpperCase().replace(/"/g, '""')}"`;
				await this.executeQuery(`SET SCHEMA ${identifier}`);
			}
		} catch (error) {
			await this.disconnect().catch(() => undefined);
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (this.closing) return await this.closing;
		const session = this.session;
		if (!session) return;
		this.session = undefined;
		this.closing = this.dispose(session);
		try {
			await this.closing;
		} finally {
			session.removeCancellationListener();
			this.closing = undefined;
		}
	}

	private async dispose(session: Session): Promise<void> {
		const { client } = session;
		if (!session.expectClose) {
			this.abort(session, new Error('HANA connection closed'));
			// Before protocol initialization hdb does not forward a public close event.
			// The aborted transport instead completes the pending connect callback.
			await this.deadline(
				session.connectFinished,
				this.cleanupTimeoutMs,
				'HANA connect cleanup timed out',
			);
			if (!session.expectClose) return;
		}
		if (!session.controller.signal.aborted && client.readyState === 'connected') {
			try {
				client.disconnect((error) => {
					if (error) this.abort(session, asError(error));
				});
			} catch (error) {
				this.abort(session, asError(error));
			}
		} else {
			this.abort(session, new Error('HANA connection closed'));
		}
		try {
			await this.deadline(session.closed, this.cleanupTimeoutMs, 'HANA disconnect timed out');
		} catch {
			this.abort(session, new Error('HANA disconnect timed out'));
			await this.deadline(
				session.closed,
				this.cleanupTimeoutMs,
				'HANA socket closure was not confirmed',
			);
		}
	}

	async executeQuery(
		query: string,
		params: unknown[] = [],
		prepare = false,
	): Promise<HanaQueryResult> {
		const session = this.session;
		if (!session || session.client.readyState !== 'connected')
			throw new Error('HANA client is not connected');
		const queryTimeoutMs = this.options.queryTimeoutMs ?? 0;
		const started = Date.now();
		const remaining = () =>
			queryTimeoutMs > 0 ? Math.max(1, queryTimeoutMs - (Date.now() - started)) : 0;
		let statement: Statement | undefined;
		let failed = false;
		let result!: HanaQueryResult;
		let cleanupError: unknown;
		try {
			if (prepare || params.length > 0) {
				statement = await this.run<Statement>(
					session,
					(done) => {
						session.client.prepare(query, (error, value) => done(error, value));
					},
					remaining(),
					'HANA query preparation timed out',
				);
			}
			const prepared = statement;
			result = await this.run<HanaQueryResult>(
				session,
				(done) => {
					const callback: ExecutionCallback = (error, result, ...resultSets) => {
						if (error) return done(asError(error, 'Query execution failed'));
						try {
							done(undefined, normalizeResult(result, resultSets));
						} catch (err) {
							done(err);
						}
					};
					if (prepared) prepared.exec(params, callback);
					else session.client.exec(query, callback);
				},
				remaining(),
				'HANA query execution timed out',
			);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			if (statement && !session.controller.signal.aborted) {
				const prepared = statement;
				try {
					await this.run<void>(
						session,
						(done) => prepared.drop(done),
						this.cleanupTimeoutMs,
						'HANA statement cleanup timed out',
					);
				} catch (error) {
					this.abort(session, asError(error));
					if (!failed) cleanupError = error;
				}
			}
		}
		if (cleanupError) throw cleanupError;
		return result;
	}

	async getAllRecords(tableName: string, columns = '*'): Promise<IDataObject[]> {
		return await this.readRows(`SELECT ${columns} FROM ${tableName}`);
	}

	async getFilteredRecords(
		tableName: string,
		whereCondition: string,
		columns = '*',
		orderBy?: string,
		limit?: number,
	): Promise<IDataObject[]> {
		let query = `SELECT ${columns} FROM ${tableName} WHERE ${whereCondition}`;
		if (orderBy) query += ` ORDER BY ${orderBy}`;
		if (limit && limit > 0) query += ` LIMIT ${limit}`;
		return await this.readRows(query);
	}

	async executeCustomQuery(query: string, params: unknown[] = []): Promise<HanaQueryResult> {
		// Preparing even without input values supplies the metadata needed to decode scalar OUT values.
		// Some HANA versions prepare a leading block comment as NIL rather than the following CALL.
		// Remove only leading ordinary comments; retain optimizer hints and all SQL literals/body text.
		const sql = query.replace(/^(?:\s+|--[^\r\n]*(?:\r\n?|\n|$)|\/\*(?!\+)[\s\S]*?\*\/)*/, '');
		if (!sql.trim()) throw new Error('SQL query is required');
		return await this.executeQuery(sql, params, true);
	}

	async testConnection(): Promise<boolean> {
		return (await this.readRows('SELECT 1 AS TEST FROM DUMMY')).length > 0;
	}

	async getTableInfo(tableName: string): Promise<IDataObject[]> {
		return await this.readRows(
			'SELECT COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE FROM TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ? ORDER BY POSITION',
			[tableName],
		);
	}

	private async readRows(query: string, params: unknown[] = []): Promise<IDataObject[]> {
		const result = await this.executeQuery(query, params);
		if (result.kind !== 'rows') throw new Error('Expected a HANA row result');
		return result.rows;
	}

	private abort(session: Session, error: Error): void {
		session.expectClose ||= ['connecting', 'connected', 'disconnected', 'disconnecting'].includes(
			session.client.readyState,
		);
		if (!session.controller.signal.aborted) session.controller.abort(error);
		session.client.destroy();
	}

	private async run<T>(
		session: Session,
		start: (done: (error?: unknown, value?: T) => void) => void,
		timeoutMs: number,
		timeoutMessage: string,
	): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			const signal = session.controller.signal;
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const done = (error?: unknown, value?: T) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				session.client.removeListener('close', onClose);
				if (error) reject(asError(error));
				else resolve(value as T);
			};
			const onAbort = () => done(signal.reason ?? new Error('HANA execution cancelled'));
			const onClose = () => done(new Error('HANA connection closed during operation'));
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
			session.client.once('close', onClose);
			if (timeoutMs > 0)
				timer = setTimeout(() => this.abort(session, new Error(timeoutMessage)), timeoutMs);
			try {
				start(done);
			} catch (error) {
				done(error);
			}
		});
	}

	private async deadline(
		promise: Promise<void>,
		timeoutMs: number,
		message: string,
	): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(message)), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
