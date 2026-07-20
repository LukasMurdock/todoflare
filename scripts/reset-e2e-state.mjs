import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const e2eStatePath = path.join(repositoryRoot, ".wrangler", "e2e-state");

if (
	path.basename(e2eStatePath) !== "e2e-state" ||
	path.basename(path.dirname(e2eStatePath)) !== ".wrangler"
) {
	throw new Error(`Refusing to reset unexpected path: ${e2eStatePath}`);
}

await rm(e2eStatePath, { recursive: true, force: true });
