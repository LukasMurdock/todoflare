import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const sourceRoot = path.join(repositoryRoot, "src");
const invalidFixture = path.join(
	repositoryRoot,
	"test/fixtures/architecture/invalid-browser-entry.ts",
);

const browserRoots = [
	"client.tsx",
	"components",
	"contexts",
	"hooks",
	"types",
	"lib/account.ts",
	"lib/utils.ts",
	"lib/api",
	"lib/collaboration",
	"lib/local-first",
	"lib/sync",
];

const sourceExtensions = [".ts", ".tsx"];
const importPattern =
	/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

async function sourceFilesUnder(targetPath) {
	const stats = await stat(targetPath);
	if (stats.isFile()) {
		return sourceExtensions.includes(path.extname(targetPath)) ? [targetPath] : [];
	}

	const files = [];
	for (const entry of await readdir(targetPath, { withFileTypes: true })) {
		const entryPath = path.join(targetPath, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFilesUnder(entryPath)));
		if (entry.isFile() && sourceExtensions.includes(path.extname(entry.name))) {
			files.push(entryPath);
		}
	}
	return files;
}

function isServerOnly(filePath) {
	const relative = path.relative(sourceRoot, filePath).split(path.sep).join("/");
	return (
		relative === "index.tsx" ||
		relative.startsWith("server/") ||
		relative.startsWith("durable-objects/")
	);
}

function importedSpecifiers(source) {
	return [...source.matchAll(importPattern)].map((match) => match[1] ?? match[2]);
}

function resolveSourceImport(importer, specifier, sourceFiles) {
	let unresolved;
	if (specifier.startsWith("@/")) {
		unresolved = path.join(sourceRoot, specifier.slice(2));
	} else if (specifier.startsWith(".")) {
		unresolved = path.resolve(path.dirname(importer), specifier);
	} else {
		return null;
	}

	for (const candidate of [
		unresolved,
		...sourceExtensions.map((extension) => `${unresolved}${extension}`),
		...sourceExtensions.map((extension) => path.join(unresolved, `index${extension}`)),
	]) {
		if (sourceFiles.has(candidate)) return candidate;
	}
	return null;
}

async function findBoundaryViolations(entryFiles, allSourceFiles) {
	const sourceFiles = new Set(allSourceFiles);
	const visited = new Set();
	const pending = [...entryFiles];
	const violations = [];

	while (pending.length > 0) {
		const importer = pending.pop();
		if (!importer || visited.has(importer)) continue;
		visited.add(importer);

		const source = await readFile(importer, "utf8");
		for (const specifier of importedSpecifiers(source)) {
			const imported = resolveSourceImport(importer, specifier, sourceFiles);
			if (!imported) continue;
			if (isServerOnly(imported)) {
				violations.push({ importer, imported });
				continue;
			}
			pending.push(imported);
		}
	}

	return violations;
}

const allSourceFiles = await sourceFilesUnder(sourceRoot);
const browserEntries = (
	await Promise.all(
		browserRoots.map((root) => sourceFilesUnder(path.join(sourceRoot, root))),
	)
).flat();

const fixtureViolations = await findBoundaryViolations(
	[invalidFixture],
	allSourceFiles,
);
if (fixtureViolations.length !== 1) {
	throw new Error("Invalid browser-boundary fixture did not produce one violation");
}

const violations = await findBoundaryViolations(browserEntries, allSourceFiles);
if (violations.length > 0) {
	const details = violations
		.map(
			({ importer, imported }) =>
				`${path.relative(repositoryRoot, importer)} imports ${path.relative(repositoryRoot, imported)}`,
		)
		.join("\n");
	throw new Error(`Browser modules import server-only code:\n${details}`);
}

console.log("Browser/server import boundaries are valid.");
