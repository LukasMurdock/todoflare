declare module "cloudflare:test" {
	interface ProvidedEnv {
		ACCOUNTS: KVNamespace;
		ACCOUNT_COORDINATOR: DurableObjectNamespace;
		PUBLIC_ID_COORDINATOR: DurableObjectNamespace;
		COLUMN_ROOM: DurableObjectNamespace;
		IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
		RATE_LIMIT_COORDINATOR: DurableObjectNamespace;
	}
}
