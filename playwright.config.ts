import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	// Runs against deployed staging with the real Claude CLI: `pnpm test:staging:agents`.
	testIgnore: ["agents-staging.spec.ts"],
	fullyParallel: true,
	forbidOnly: true,
	retries: 0,
	workers: 2,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4173",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "pnpm e2e:serve",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
		timeout: 120_000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
