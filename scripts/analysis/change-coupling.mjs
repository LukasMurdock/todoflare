// Change-coupling and hotspot analysis from git history.
//
// Usage: node scripts/analysis/change-coupling.mjs [--json] [--max-files N]
//
// Coupling between two files = shared commits / commits touching either file
// (Jaccard). Large commits are down-weighted by 1 / (files - 1) so a single
// sweeping commit cannot dominate the result. Hotspot = commit count x lines.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const maxFilesIndex = args.indexOf("--max-files");
const maxFilesPerCommit =
	maxFilesIndex >= 0 ? Number(args[maxFilesIndex + 1]) : Number.POSITIVE_INFINITY;

const tracked = /^(src|test|e2e|scripts|migrations)\//;
const ignored = /^scripts\/analysis\//;

function gitCommits() {
	const output = execFileSync(
		"git",
		["log", "--no-merges", "--format=@@%h", "--name-only", "--", "src", "test", "e2e", "scripts", "migrations"],
		{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	const commits = [];
	let current = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("@@")) {
			current = { sha: line.slice(2), files: [] };
			commits.push(current);
		} else if (line && current && tracked.test(line) && !ignored.test(line)) {
			current.files.push(line);
		}
	}
	return commits.filter((commit) => commit.files.length > 0);
}

function lineCount(file) {
	const absolute = path.join(root, file);
	return existsSync(absolute) ? readFileSync(absolute, "utf8").split("\n").length : 0;
}

const commits = gitCommits().filter((commit) => commit.files.length <= maxFilesPerCommit);
const revisions = new Map();
const pairs = new Map();

for (const { files } of commits) {
	const unique = [...new Set(files)].sort();
	for (const file of unique) revisions.set(file, (revisions.get(file) ?? 0) + 1);
	const weight = unique.length > 1 ? 1 / (unique.length - 1) : 0;
	for (let i = 0; i < unique.length; i++) {
		for (let j = i + 1; j < unique.length; j++) {
			const key = `${unique[i]}\u0000${unique[j]}`;
			const entry = pairs.get(key) ?? { shared: 0, weighted: 0 };
			entry.shared += 1;
			entry.weighted += weight;
			pairs.set(key, entry);
		}
	}
}

function directoryDistance(a, b) {
	const left = path.dirname(a).split("/");
	const right = path.dirname(b).split("/");
	let common = 0;
	while (common < left.length && common < right.length && left[common] === right[common]) common++;
	return left.length - common + (right.length - common);
}

const coupling = [...pairs.entries()]
	.map(([key, { shared, weighted }]) => {
		const [a, b] = key.split("\u0000");
		const union = revisions.get(a) + revisions.get(b) - shared;
		return {
			a,
			b,
			shared,
			weighted: Number(weighted.toFixed(2)),
			jaccard: Number((shared / union).toFixed(2)),
			distance: directoryDistance(a, b),
		};
	})
	.filter((pair) => pair.shared >= 3 && existsSync(path.join(root, pair.a)) && existsSync(path.join(root, pair.b)))
	.sort((x, y) => y.weighted - x.weighted || y.jaccard - x.jaccard);

const hotspots = [...revisions.entries()]
	.filter(([file]) => existsSync(path.join(root, file)) && file.startsWith("src/"))
	.map(([file, revs]) => {
		const lines = lineCount(file);
		return { file, revisions: revs, lines, score: revs * lines };
	})
	.sort((x, y) => y.score - x.score);

// Distant coupling: src files in different directories that keep changing together.
const distantCoupling = coupling.filter(
	(pair) => pair.a.startsWith("src/") && pair.b.startsWith("src/") && pair.distance >= 2,
);

const report = {
	commitsAnalyzed: commits.length,
	maxFilesPerCommit: Number.isFinite(maxFilesPerCommit) ? maxFilesPerCommit : null,
	hotspots: hotspots.slice(0, 15),
	topCoupling: coupling.slice(0, 20),
	distantCoupling: distantCoupling.slice(0, 20),
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`Commits analyzed: ${report.commitsAnalyzed}`);
	console.log("\nHotspots (revisions x lines, src only)");
	for (const h of report.hotspots) {
		console.log(`  ${String(h.score).padStart(6)}  ${String(h.revisions).padStart(3)} revs  ${String(h.lines).padStart(5)} lines  ${h.file}`);
	}
	console.log("\nDistant co-change in src (directory distance >= 2, weighted by commit size)");
	for (const c of report.distantCoupling) {
		console.log(`  w=${c.weighted.toFixed(2)} shared=${c.shared} j=${c.jaccard.toFixed(2)}  ${c.a}  <->  ${c.b}`);
	}
}
