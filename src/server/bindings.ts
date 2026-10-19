import type { Context, Hono } from "hono";



export type Bindings = {
	AUTH_DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	AUTH_ORIGIN?: string;
	AUTH_RP_ID?: string;
	AUTH_TEST_BYPASS?: string;
	ACCOUNTS: KVNamespace;
	COLUMN_ROOM: DurableObjectNamespace;
	IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
	RATE_LIMIT_COORDINATOR: DurableObjectNamespace;
	ACCOUNT_COORDINATOR: DurableObjectNamespace;
	PUBLIC_ID_COORDINATOR: DurableObjectNamespace;
	RATE_LIMIT_DISABLED?: string;
	READ_ONLY_MODE?: string;
	/** "true" serves agent access; anything else hides every agent route. */
	AGENT_ACCESS_ENABLED?: string;
	BACKUPS?: R2Bucket;
	BACKUP_ADMIN_TOKEN?: string;
	AUTO_BACKUP_ENABLED?: string;
	BACKUP_MAX_COLUMNS?: string;
	LIFECYCLE_METRICS?: {
		writeDataPoint(event: {
			blobs?: string[];
			doubles?: number[];
			indexes?: string[];
		}): void;
	};
};

export type AppEnv = { Bindings: Bindings };
export type AppContext = Context<AppEnv>;
export type App = Hono<AppEnv>;
