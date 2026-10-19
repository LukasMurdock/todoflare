import { execFileSync } from "child_process";
import path from "path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { excludeUnusedYjsProviders } from "@todoflare/board/vite";

const isE2e = process.env.TODOFLARE_E2E === "true";

// Only commit facts, never the build time: `pnpm deploy` rebuilds and requires
// the artifact hashes of the verified frozen build.
function readBuildInfo() {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		return {
			commit: git("rev-parse", "--short=12", "HEAD"),
			committedAt: git("log", "-1", "--format=%cI"),
			dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
		};
	} catch {
		return { commit: "unknown", committedAt: null, dirty: false };
	}
}

const buildInfo = readBuildInfo();
const buildLabel = buildInfo.dirty ? `${buildInfo.commit}-dirty` : buildInfo.commit;

export default defineConfig({
	define: {
		__TODOFLARE_E2E__: JSON.stringify(isE2e),
		__TODOFLARE_BUILD__: JSON.stringify(buildInfo),
	},
	plugins: [
		{
			name: "todoflare-build-meta",
			transformIndexHtml: () => [{ tag: "meta", attrs: { name: "todoflare-build", content: buildLabel }, injectTo: "head" }],
		},
		excludeUnusedYjsProviders(),
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
