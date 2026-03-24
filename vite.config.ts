import path from "path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [
		tailwindcss(),
		cloudflare({
			// Keep local dev fully offline (no Cloudflare login).
			remoteBindings: false,
			// Persist KV/DO state across restarts under `.wrangler/state/v3`.
			persistState: true,
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
