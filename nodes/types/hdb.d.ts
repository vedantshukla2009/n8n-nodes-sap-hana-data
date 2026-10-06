declare module 'hdb' {
	import { EventEmitter } from 'events';

	export type ExecutionCallback = (
		err: unknown,
		result?: unknown,
		...resultSets: unknown[]
	) => void;

	export interface ClientOptions {
		host: string;
		port: number;
		user: string;
		password: string;
		databaseName?: string;
		useTLS?: boolean;
		rejectUnauthorized?: boolean;
		initializationTimeout?: number;
		signal?: AbortSignal;
	}

	export interface Statement {
		exec(params: unknown[] | Record<string, unknown>, cb: ExecutionCallback): void;
		drop(cb: (err?: unknown) => void): void;
	}

	export interface Client extends EventEmitter {
		readonly readyState: string;
		connect(cb: (err?: unknown) => void): void;
		disconnect(cb: (err?: unknown) => void): void;
		destroy(): void;
		exec(sql: string, cb: ExecutionCallback): void;
		prepare(sql: string, cb: (err: unknown, statement: Statement) => void): void;
	}

	const hdb: { createClient(options: ClientOptions): Client };
	export default hdb;
}
