declare module "cloudflare:test" {
	interface ProvidedEnv {
		ACCOUNTS: KVNamespace;
		COLUMN_ROOM: DurableObjectNamespace;
		IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
		RATE_LIMIT_COORDINATOR: DurableObjectNamespace;
	}
}
