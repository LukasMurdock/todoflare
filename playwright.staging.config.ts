import { defineConfig, devices } from "@playwright/test";

// Real HTTPS passkeys and session cookies; creates only synthetic staging data.
export default defineConfig({
	testDir: "./e2e",
	testMatch: "passkey-auth.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	reporter: "list",
	use: { ...devices["Desktop Chrome"], baseURL: "https://staging.todo.tamesystems.org", trace: "retain-on-failure" },
});
