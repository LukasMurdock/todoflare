declare module "cloudflare:test" {
	interface ProvidedEnv {
		ACCOUNTS: KVNamespace;
		RATE_LIMIT: KVNamespace;
		COLUMN_ROOM: DurableObjectNamespace;
	}
}
