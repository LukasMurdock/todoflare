import path from "path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const isE2e = process.env.TODOFLARE_E2E === "true";

export default defineConfig({
	plugins: [
		tailwindcss(),
		cloudflare({
			// Keep local dev fully offline (no Cloudflare login).
			remoteBindings: false,
			// E2E resets only its dedicated store; normal development state is untouched.
			persistState: isE2e ? { path: ".wrangler/e2e-state" } : true,
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
