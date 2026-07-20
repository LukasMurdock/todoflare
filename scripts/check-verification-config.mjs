import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const [packageJson, playwrightConfig, viteConfig, resetScript] =
	await Promise.all([
		readFile(path.join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
		readFile(path.join(repositoryRoot, "playwright.config.ts"), "utf8"),
		readFile(path.join(repositoryRoot, "vite.config.ts"), "utf8"),
		readFile(path.join(repositoryRoot, "scripts/reset-e2e-state.mjs"), "utf8"),
	]);

const verify = packageJson.scripts?.verify;
if (typeof verify !== "string") throw new Error("Missing verify script");
if (verify.includes("verify:fast")) {
	throw new Error("Full verification must not invoke the build-owning fast gate");
}
if ((verify.match(/build:e2e/g) ?? []).length !== 1) {
	throw new Error("Full verification must invoke exactly one E2E build");
}
if (!verify.includes("test:e2e:run")) {
	throw new Error("Full verification must run the build-free E2E command");
}

if (playwrightConfig.includes("pnpm build") || playwrightConfig.includes("rm -rf")) {
	throw new Error("Playwright webServer must not build or delete state directly");
}
if (!playwrightConfig.includes('command: "pnpm e2e:serve"')) {
	throw new Error("Playwright must use the isolated E2E server command");
}
if (!viteConfig.includes('path: ".wrangler/e2e-state"')) {
	throw new Error("Vite must configure an explicit E2E persistence directory");
}
if (
	!resetScript.includes('path.basename(e2eStatePath) !== "e2e-state"') ||
	!resetScript.includes("await rm(e2eStatePath")
) {
	throw new Error("E2E reset must remain narrowly guarded and explicit");
}

console.log("Verification configuration is isolated and single-build.");
