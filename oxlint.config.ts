import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";
import landmines from "@interfere/landmines/configs/recommended.json" with { type: "json" };

export default defineConfig({
	extends: [cloudflare],
	jsPlugins: [{ name: "landmines", specifier: "@interfere/landmines" }],
	rules: {
		...Object.fromEntries(Object.entries(landmines.rules).map(([rule, severity]) => {
			if (severity !== "error") {throw new Error(`Unexpected severity for ${rule}`);}
			return [rule, severity] as const;
		})),
		"no-console": ["error", { allow: ["warn", "error"] }],
	},
	env: cloudflare.env,
	overrides: [{ files: ["scripts/**", "design-capture/**", "packages/board/build-css.mjs", "src/index.tsx"], rules: { "no-console": "off" } }],
	ignorePatterns: [...cloudflare.ignorePatterns, "repos/", ".wrangler/", "dist/", "test-results/", "playwright-report/"],
});
