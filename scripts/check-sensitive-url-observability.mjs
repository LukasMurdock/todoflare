import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(repositoryRoot, "wrangler.jsonc"), "utf8");
const withoutComments = source
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "")
	.replace(/,\s*([}\]])/g, "$1");
const config = JSON.parse(withoutComments);

function assertSafeObservability(value, label) {
	const logs = value?.observability?.logs;
	const traces = value?.observability?.traces;
	if (
		logs?.enabled !== false ||
		logs?.invocation_logs !== false ||
		logs?.persist !== false ||
		logs?.head_sampling_rate !== 0 ||
		traces?.enabled !== false ||
		traces?.persist !== false ||
		traces?.head_sampling_rate !== 0
	) {
		throw new Error(`${label} must keep request logging and tracing disabled`);
	}
}

assertSafeObservability(config, "wrangler.jsonc");
for (const [name, environment] of Object.entries(config.env ?? {})) {
	assertSafeObservability(
		{ observability: environment.observability ?? config.observability },
		`wrangler.jsonc env.${name}`,
	);
}

const sourceRoot = path.join(repositoryRoot, "src");
const sourceEntries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
const forbiddenCredentialUrlPatterns = [
	/\?accountId=/,
	/["'`]\/api\/account\/:/,
	/\/api\/account\/\$\{/,
	/\/share\/\$\{normalizeAccountId/,
];
for (const entry of sourceEntries) {
	if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
	const filePath = path.join(entry.parentPath, entry.name);
	const fileSource = await readFile(filePath, "utf8");
	if (forbiddenCredentialUrlPatterns.some((pattern) => pattern.test(fileSource))) {
		throw new Error(
			`${path.relative(repositoryRoot, filePath)} places an account credential in a URL`,
		);
	}
}

console.log("Sensitive request URL boundaries and observability are safe.");
