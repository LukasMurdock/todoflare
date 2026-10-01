import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const authMigrations = await readD1Migrations("./migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { AUTH_TEST_BYPASS: "true", TEST_AUTH_MIGRATIONS: authMigrations },
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["e2e/**"],
	},
});
