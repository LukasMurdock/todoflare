// Change-cost harness: how far does one conceptual change spread, and how much
// of that spread does the compiler point you to?
//
// Usage: node scripts/analysis/change-cost.mjs [--json] [--only SCENARIO] [--rev REV]
//
// Each scenario applies a minimal "seed" edit (the one declaration a developer
// would naturally change first) to a scratch worktree of HEAD, then runs both
// TypeScript projects. Files the compiler flags are "guided" sites. The
// "required" set is the union of guided sites and the footprint of a sibling
// fact that already exists (every file that restates the sibling). Required
// sites the compiler does not flag are "silent": a developer must remember
// them, and forgetting one produces no error.
//
// The working tree is never touched; a committed revision (default HEAD) is measured.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const revision = args.includes("--rev") ? args[args.indexOf("--rev") + 1] : "HEAD";

let measuredRoot = root;

function inventory(family) {
	const output = execFileSync(
		process.execPath,
		[
			path.join(root, "scripts/analysis/fact-inventory.mjs"),
			"--json",
			"--family",
			family,
			"--root",
			measuredRoot,
		],
		{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(output)[0];
}

function siblingFiles(family, member) {
	const entry = inventory(family).members.find((m) => m.member === member);
	if (!entry) throw new Error(`Sibling ${family}:${member} not found in inventory`);
	return entry.sites.map((site) => site.file);
}

/**
 * A seed is a list of alternatives, one per code revision, each mapping a file
 * to [anchor, insertion] pairs. The first alternative whose files and anchors
 * all exist in the measured revision is applied.
 */
function applicableSeed(worktree, alternatives) {
	return alternatives.find((seed) =>
		Object.entries(seed).every(([file, edits]) => {
			const absolute = path.join(worktree, file);
			if (!existsSync(absolute)) return false;
			const text = readFileSync(absolute, "utf8");
			return edits.every(([anchor]) => text.includes(anchor));
		}),
	);
}

const scenarios = [
	{
		id: "add-account-command",
		description: 'Add account command "column.rename" { columnId, title }',
		seed: [
			{
				"src/lib/api/account-commands.ts": [
					[
						"export const ACCOUNT_COMMANDS = {\n",
						`\t"column.rename": defineCommand({
\t\tmethod: "PUT",
\t\tpath: "/api/column/:id/title",
\t\tpayload: z.object({ columnId: columnIdContractSchema, title: z.string() }),
\t\taffectedColumnId: ({ columnId }) => columnId,
\t\tbody: z.object({ title: z.string() }).strict(),
\t\trequest: ({ columnId, title }) => ({ id: columnId, body: { title } }),
\t\tresponse: z.object({ success: z.literal(true) }),
\t}),\n`,
					],
				],
			},
			{
				"src/lib/sync/contracts.ts": [
					['\t"column.hide_shared",\n', '\t"column.rename",\n'],
					[
						'\t"column.hide_shared": { hiddenSharedColumns: string[] };\n',
						'\t"column.rename": { columnId: string; title: string };\n',
					],
				],
			},
		],
		siblings: () => [
			...siblingFiles("account-command", "column.public.disable"),
			...siblingFiles("http-route", "DELETE /api/column/:id/public"),
		],
	},
	{
		id: "add-column-meta-field",
		description: "Add field color: string | null to ColumnMeta",
		seed: [
			{
				"src/lib/api/account-contract.ts": [
					["\t\tpublicId: publicIdContractSchema.nullable(),\n", "\t\tcolor: z.string().nullable(),\n"],
				],
			},
			{
				"src/types/account.ts": [
					[
						'\tpublicId: string | null; // Short ID for public read-only link (e.g., "x7Km9p2N")\n',
						"\tcolor: string | null;\n",
					],
				],
			},
		],
		siblings: () => siblingFiles("record-shape", "ColumnMeta"),
	},
	{
		id: "add-terminal-replay-reason",
		description: 'Add terminal replay reason "quota_exceeded"',
		seed: [
			{ "src/lib/sync/contracts.ts": [["export const TERMINAL_REPLAY_REASONS = [\n", '\t"quota_exceeded",\n']] },
			{ "src/lib/sync/contracts.ts": [['\t| "validation_failed"', '\n\t| "quota_exceeded"']] },
		],
		siblings: () => siblingFiles("terminal-replay-reason", "validation_failed"),
	},
	{
		id: "add-api-error-code",
		description: 'Add API error code "quota_exceeded"',
		seed: [{ "src/lib/api/errors.ts": [['\t"idempotency_in_progress",\n', '\t"quota_exceeded",\n']] }],
		siblings: () => siblingFiles("api-error-code", "account_export_incomplete"),
	},
	{
		id: "add-sync-message",
		description: 'Add websocket message { type: "column-renamed" }',
		seed: [
			{
				"src/types/account.ts": [
					['\t| { type: "access-revoked" }', '\n\t| { type: "column-renamed"; title: string }'],
				],
			},
		],
		siblings: () => [
			...siblingFiles("sync-message", "column-deleted"),
			// The server emits the frame by opcode, not by message type.
			"src/durable-objects/column-room.ts",
		],
	},
	{
		id: "add-http-route",
		description: "Add an authenticated column mutation route (no single seed exists)",
		seed: [{}],
		siblings: () => siblingFiles("http-route", "DELETE /api/column/:id/public"),
	},
];

function typecheck(worktree) {
	const tsc = path.join(root, "node_modules/.bin/tsc");
	const flagged = new Map();
	for (const project of ["tsconfig.json", "test/tsconfig.json"]) {
		const result = spawnSync(tsc, ["--noEmit", "--pretty", "false", "-p", project], {
			cwd: worktree,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		for (const line of result.stdout.split("\n")) {
			const match = /^(.+?)\((\d+),\d+\): error (TS\d+)/.exec(line);
			if (!match) continue;
			const file = path.relative(worktree, path.resolve(worktree, match[1]));
			const entries = flagged.get(file) ?? new Set();
			entries.add(`${match[2]}:${match[3]}`);
			flagged.set(file, entries);
		}
	}
	return flagged;
}

const area = (file) => (file.startsWith("src/") ? "src" : "other");

function measure(worktree, scenario) {
	execFileSync("git", ["checkout", "--quiet", "--", "."], { cwd: worktree });
	// Footprint of the existing sibling, measured before the seed changes anything.
	const siblings = scenario.siblings();
	const seed = applicableSeed(worktree, scenario.seed);
	if (!seed) throw new Error(`No seed for ${scenario.id} applies to this revision`);
	const seedFiles = Object.keys(seed);
	for (const [file, edits] of Object.entries(seed)) {
		const absolute = path.join(worktree, file);
		let text = readFileSync(absolute, "utf8");
		for (const [anchor, addition] of edits) text = text.replace(anchor, anchor + addition);
		writeFileSync(absolute, text);
	}
	const flagged = seedFiles.length ? typecheck(worktree) : new Map();
	const guided = new Set([...flagged.keys()].filter((file) => !seedFiles.includes(file)));
	const required = new Set([...siblings, ...guided].filter((file) => !seedFiles.includes(file)));
	const silent = [...required].filter((file) => !guided.has(file)).sort();
	const count = (set, where) => [...set].filter((file) => area(file) === where).length;
	return {
		id: scenario.id,
		description: scenario.description,
		seedFiles,
		requiredSrc: count(required, "src"),
		guidedSrc: count(guided, "src"),
		silentSrc: silent.filter((file) => area(file) === "src").length,
		requiredOther: count(required, "other"),
		silentOther: silent.filter((file) => area(file) === "other").length,
		guided: [...guided].sort().map((file) => ({ file, errors: flagged.get(file)?.size ?? 0 })),
		silent,
	};
}

const worktree = mkdtempSync(path.join(tmpdir(), "todoflare-change-cost-"));
execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree, revision], { cwd: root });
symlinkSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"));
measuredRoot = worktree;

let results;
try {
	results = scenarios.filter((s) => !only || s.id === only).map((scenario) => measure(worktree, scenario));
} finally {
	execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root });
	rmSync(worktree, { recursive: true, force: true });
}

if (asJson) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log("scenario                      required(src)  guided(src)  SILENT(src)  required(test/e2e/scripts)");
	for (const r of results) {
		console.log(
			`${r.id.padEnd(30)}${String(1 + r.requiredSrc).padStart(8)}${String(r.guidedSrc).padStart(13)}${String(r.silentSrc).padStart(13)}${String(r.requiredOther).padStart(16)}`,
		);
	}
	console.log("(required(src) includes the seed file)");
	for (const r of results) {
		console.log(`\n## ${r.id}: ${r.description}`);
		console.log(`   seed:   ${r.seedFiles.join(", ") || "(none: no single declaration to start from)"}`);
		for (const g of r.guided) console.log(`   guided: ${g.file} (${g.errors} errors)`);
		for (const s of r.silent) console.log(`   SILENT: ${s}`);
	}
}
