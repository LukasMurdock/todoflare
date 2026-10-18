import { defineConfig, devices } from "@playwright/test";

/**
 * Visual baseline for refactors that must not change what users see.
 * Not part of `pnpm verify`: screenshots depend on the machine's fonts and
 * renderer, so they only compare builds captured on the same machine.
 *
 *   pnpm build:e2e && pnpm test:visual --update-snapshots   # capture baseline
 *   pnpm build:e2e && pnpm test:visual                      # compare, 0 pixels allowed
 *
 * VISUAL_SNAPSHOT_DIR selects where snapshots live (default .visual-baseline).
 */
export default defineConfig({
	testDir: "./visual",
	testMatch: "**/*.visual.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	reporter: "list",
	snapshotPathTemplate: `${process.env.VISUAL_SNAPSHOT_DIR ?? ".visual-baseline"}/{arg}{ext}`,
	expect: {
		toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide", scale: "css" },
	},
	use: {
		baseURL: "http://127.0.0.1:4173",
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 1,
		colorScheme: "light",
		locale: "en-US",
		timezoneId: "UTC",
	},
	webServer: {
		command: "pnpm e2e:serve",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
		timeout: 120000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } }],
});
