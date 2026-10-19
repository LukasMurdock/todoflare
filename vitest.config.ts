import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const authMigrations = await readD1Migrations("./migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { AUTH_TEST_BYPASS: "true", AGENT_ACCESS_ENABLED: "true", TEST_AUTH_MIGRATIONS: authMigrations },
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/setup-auth-db.ts"],
		exclude: ["e2e/**"],
	},
});
