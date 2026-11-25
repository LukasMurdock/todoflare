import { rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(
	import.meta.dirname,
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
