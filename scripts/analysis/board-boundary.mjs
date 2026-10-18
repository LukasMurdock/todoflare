// Board boundary inventory: how far is the todo board from being an embeddable
// component?
//
// Usage: node scripts/analysis/board-boundary.mjs [--json] [--check] [--root DIR]
//
// --check exits non-zero if any board module imports a host module, directly or
// transitively, or any host module imports the board other than through its
// package entry (wired into `pnpm verify` as check:board-boundary).
//
// Modules are in one of two zones: "board" (the @todoflare/board package) and
// "host" (the todoflare application around it: accounts, Cloudflare sync,
// local-first storage, routes). The report lists
//   1. every import that crosses from board into host, with the names used,
//      which is the surface the board would need from adapters or props;
//   2. host modules the board pulls in transitively;
//   3. embedding hazards inside board modules: side-effect imports, module
//      state, top-level statements, global listeners, direct storage/network,
//      global registries and global UI singletons.
// Zones are declared in ./board-zones.mjs.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BOARD_PACKAGE, BOARD_ROOT, zoneOf } from "./board-zones.mjs";

const args = process.argv.slice(2);
const root = args.includes("--root")
	? path.resolve(args[args.indexOf("--root") + 1])
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asJson = args.includes("--json");
const check = args.includes("--check");

const BROWSER = /^src\/(client\.tsx|components|contexts|hooks|types|lib)(\/|$)/;
const SERVER_ONLY = /^src\/lib\/(rate-limit|http-account-auth)\.ts$/;


function walk(dir) {
	const out = [];
	for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(rel));
		else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
	}
	return out;
}

const files = [
	...walk("src").filter((file) => BROWSER.test(file) && !SERVER_ONLY.test(file)),
	...walk(BOARD_ROOT),
];
const sources = new Map(
	files.map((file) => {
		const text = readFileSync(path.join(root, file), "utf8");
		const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		return [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)];
	}),
);

function resolveImport(from, specifier) {
	let base;
	if (specifier === BOARD_PACKAGE) base = `${BOARD_ROOT}/index`;
	else if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
	else if (specifier.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	else return null;
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
		if (sources.has(candidate)) return candidate;
	}
	return null;
}

function importsOf(file) {
	const out = [];
	for (const statement of sources.get(file).statements) {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
		if (!statement.moduleSpecifier) continue;
		const specifier = statement.moduleSpecifier.text;
		const clause = ts.isImportDeclaration(statement) ? statement.importClause : null;
		const names = [];
		if (clause?.name) names.push("default");
		const bindings = clause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
		} else if (bindings) names.push("*");
		out.push({
			specifier,
			target: resolveImport(file, specifier),
			names,
			typeOnly: Boolean(clause?.isTypeOnly) || (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)),
			sideEffectOnly: ts.isImportDeclaration(statement) && !clause,
		});
	}
	return out;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const GLOBAL_OBJECTS = new Set(["window", "document", "localStorage", "sessionStorage", "indexedDB", "navigator"]);

function hazardsOf(file) {
	const sf = sources.get(file);
	const hazards = [];
	// Registration functions imported from packages write to registries shared by every instance.
	const packageImports = new Set(importsOf(file).filter((imp) => !imp.target && !imp.specifier.startsWith(".")).flatMap((imp) => imp.names));
	const add = (kind, node, detail) => hazards.push({ kind, line: lineOf(sf, node), detail });

	for (const imp of importsOf(file)) {
		if (imp.sideEffectOnly && !/\.css$/.test(imp.specifier)) {
			const statement = sf.statements.find((s) => ts.isImportDeclaration(s) && s.moduleSpecifier.text === imp.specifier);
			add("side-effect import", statement, imp.specifier);
		}
	}

	for (const statement of sf.statements) {
		if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue; // "use client"
		if (ts.isVariableStatement(statement)) {
			const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
			for (const declaration of statement.declarationList.declarations) {
				const init = declaration.initializer;
				if (isLet) add("mutable module state", declaration, declaration.name.getText(sf));
				else if (init && ts.isNewExpression(init) && /^(Set|Map|WeakMap|EventTarget)$/.test(init.expression.getText(sf))) {
					add("module singleton", declaration, `${declaration.name.getText(sf)} = new ${init.expression.getText(sf)}`);
				}
			}
			continue;
		}
		const isDisplayName = ts.isExpressionStatement(statement) && /^\w+\.displayName\s*=/.test(statement.getText(sf));
		if (isDisplayName) continue;
		if (ts.isExpressionStatement(statement) || ts.isIfStatement(statement) || ts.isForStatement(statement)) {
			add("top-level statement", statement, statement.getText(sf).split("\n")[0].slice(0, 70));
		}
	}

	const visit = (node, depth) => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(sf);
			if (/^(window|document)\.addEventListener$/.test(callee)) add("global listener", node, `${callee}("${node.arguments[0]?.getText(sf).replace(/["']/g, "")}")`);
			if (/^(fetch|window\.fetch)$/.test(callee)) add("network", node, callee);
			if (/^(toast)(\.|$)/.test(callee)) add("global UI singleton", node, callee);
			if (/^register[A-Z]/.test(callee) && packageImports.has(callee)) add("global registry", node, callee);
			if (callee === "window.open") add("navigation", node, callee);
		}
		if (ts.isIdentifier(node) && /^(localStorage|sessionStorage|indexedDB)$/.test(node.text)) add("direct storage", node, node.text);
		if (depth === 0 && ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text)) add("global at import time", node, node.text);
		const nested = ts.isFunctionLike(node) || ts.isClassLike(node);
		ts.forEachChild(node, (child) => visit(child, nested ? depth + 1 : depth));
	};
	for (const statement of sf.statements) {
		if (ts.isImportDeclaration(statement)) continue;
		visit(statement, 0);
	}
	// Dedupe storage/global hits to one per name per file.
	const seen = new Set();
	return hazards.filter((h) => {
		const key = ["direct storage", "global at import time", "global UI singleton", "network"].includes(h.kind) ? `${h.kind}:${h.detail}` : `${h.kind}:${h.line}:${h.detail}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const lines = (file) => sources.get(file).text.split("\n").length;
const boardFiles = files.filter((f) => zoneOf(f) === "board").sort();
const hostFiles = files.filter((f) => zoneOf(f) === "host").sort();

// 1. Direct board -> host edges.
const crossings = [];
for (const file of boardFiles) {
	for (const imp of importsOf(file)) {
		if (imp.target && zoneOf(imp.target) === "host") {
			crossings.push({ from: file, to: imp.target, names: imp.names, typeOnly: imp.typeOnly, sideEffectOnly: imp.sideEffectOnly });
		}
	}
}

// Host modules must use the package entry, never a path into the package.
const deepImports = hostFiles.flatMap((file) =>
	importsOf(file)
		.filter((imp) => imp.specifier.startsWith(`${BOARD_PACKAGE}/`) || (imp.target && zoneOf(imp.target) === "board" && imp.specifier !== BOARD_PACKAGE))
		.map((imp) => ({ from: file, specifier: imp.specifier })),
);

// 2. Host modules reachable from the board (value imports only).
const reachable = new Set();
const stack = boardFiles.slice();
const visited = new Set(stack);
while (stack.length) {
	const file = stack.pop();
	for (const imp of importsOf(file)) {
		if (!imp.target || imp.typeOnly || visited.has(imp.target)) continue;
		visited.add(imp.target);
		stack.push(imp.target);
		if (zoneOf(imp.target) === "host") reachable.add(imp.target);
	}
}

// 3. Hazards.
const hazards = boardFiles.flatMap((file) => hazardsOf(file).map((h) => ({ file, ...h })));
const hostHazards = hostFiles.flatMap((file) =>
	hazardsOf(file)
		.filter((h) => ["side-effect import", "global registry", "mutable module state", "top-level statement", "global at import time"].includes(h.kind))
		.map((h) => ({ file, ...h })),
);

const report = {
	zones: {
		board: { files: boardFiles.length, lines: boardFiles.reduce((n, f) => n + lines(f), 0) },
		host: { files: hostFiles.length, lines: hostFiles.reduce((n, f) => n + lines(f), 0) },
	},
	crossings,
	crossingCount: crossings.length,
	deepImports,
	valueCrossingCount: crossings.filter((c) => !c.typeOnly).length,
	reachableHost: [...reachable].sort().map((file) => ({ file, lines: lines(file) })),
	reachableHostLines: [...reachable].reduce((n, f) => n + lines(f), 0),
	hazards,
	hostImportTimeHazards: hostHazards,
};

if (check) {
	if (report.crossingCount > 0 || report.reachableHost.length > 0 || deepImports.length > 0) {
		console.error(`The board package must not import app modules, and the app must import the board only as "${BOARD_PACKAGE}".`);
		for (const c of crossings) console.error(`  ${c.from} -> ${c.to}`);
		for (const d of deepImports) console.error(`  ${d.from} imports "${d.specifier}"`);
		process.exit(1);
	}
	console.log(`Board boundary holds: ${report.zones.board.files} board modules import no host module.`);
} else if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`board: ${report.zones.board.files} files, ${report.zones.board.lines} lines`);
	console.log(`host:  ${report.zones.host.files} files, ${report.zones.host.lines} lines\n`);
	console.log(`## Board -> host imports (${report.crossingCount}, ${report.valueCrossingCount} value)`);
	for (const c of crossings) {
		console.log(`  ${c.from} -> ${c.to}${c.typeOnly ? " (type)" : ""}${c.sideEffectOnly ? " (side effect)" : ""}: ${c.names.join(", ") || "-"}`);
	}
	console.log(`\n## Host modules the board pulls in (${report.reachableHost.length} files, ${report.reachableHostLines} lines)`);
	for (const r of report.reachableHost) console.log(`  ${r.file} (${r.lines})`);
	console.log(`\n## Embedding hazards in board modules (${hazards.length})`);
	for (const h of hazards) console.log(`  ${h.file}:${h.line} ${h.kind}: ${h.detail}`);
	console.log(`\n## Import-time hazards in host modules (${hostHazards.length})`);
	for (const h of hostHazards) console.log(`  ${h.file}:${h.line} ${h.kind}: ${h.detail}`);
}
