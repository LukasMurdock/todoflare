import { defineConfig, devices } from "@playwright/test";

/** Tests the board inside hosts other than todoflare (examples/*). Part of `pnpm verify`. */
export default defineConfig({
	testDir: "./hosts-e2e",
	fullyParallel: true,
	forbidOnly: true,
	retries: process.env.CI ? 2 : 0,
	workers: 2,
	reporter: "list",
	use: { baseURL: "http://localhost:4180", trace: "on-first-retry" },
	webServer: {
		command: "pnpm --filter @todoflare/example-minimal dev",
		url: "http://localhost:4180",
		reuseExistingServer: false,
		timeout: 120000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
