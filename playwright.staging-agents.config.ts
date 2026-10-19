import { defineConfig, devices } from "@playwright/test";

// Agent access on staging with real passkeys, the real Claude Code CLI and the
// MCP SDK's OAuth client. Creates only synthetic staging data; one model call.
export default defineConfig({
	testDir: "./e2e",
	testMatch: "agents-staging.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	reporter: "list",
	use: { ...devices["Desktop Chrome"], baseURL: "https://staging.todo.tamesystems.org", trace: "retain-on-failure", actionTimeout: 20_000 },
});
