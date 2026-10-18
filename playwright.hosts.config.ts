import { defineConfig, devices } from "@playwright/test";

/**
 * Tests the board inside hosts other than todoflare (examples/*). Part of `pnpm verify`.
 * - minimal: plain Vite + React, client-rendered.
 * - void: a Void island page, server-rendered on the Workers runtime, then hydrated.
 *   examples/void is its own pnpm project; its dev script installs it.
 */
export default defineConfig({
	testDir: "./hosts-e2e",
	fullyParallel: true,
	forbidOnly: true,
	retries: process.env.CI ? 2 : 0,
	workers: 2,
	reporter: "list",
	use: { trace: "on-first-retry" },
	webServer: [
		{
			command: "pnpm --filter @todoflare/example-minimal dev",
			url: "http://localhost:4180",
			reuseExistingServer: false,
			timeout: 120000,
		},
		{
			command: "pnpm --dir examples/void dev",
			url: "http://localhost:4280",
			reuseExistingServer: false,
			timeout: 240000,
		},
	],
	projects: [
		{ name: "minimal", testMatch: "minimal.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4180" } },
		{ name: "void", testMatch: "void.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4280" } },
	],
});
