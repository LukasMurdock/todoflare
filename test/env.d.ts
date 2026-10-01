import type { Bindings } from "../src/index";

declare global {
	namespace Cloudflare {
		interface Env extends Bindings {
			BACKUPS: R2Bucket;
			TEST_AUTH_MIGRATIONS: Array<{ name: string; queries: string[] }>;
		}
	}
}
