// Fact inventory: where is each piece of domain knowledge spelled out?
//
// Usage: node scripts/analysis/fact-inventory.mjs [--json] [--family NAME] [--root DIR]
//
// A "fact" is a named piece of knowledge (an account command type, an HTTP
// route, an error code, a record shape). For each fact this reports every file
// that restates it as a literal, so a fact restated in N files is a fact a
// change must keep consistent in N places. Families are discovered from their
// canonical declarations, so the inventory stays honest as the code changes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const args = process.argv.slice(2);
const root = args.includes("--root")
	? path.resolve(args[args.indexOf("--root") + 1])
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asJson = args.includes("--json");
const familyFilter = args.includes("--family") ? args[args.indexOf("--family") + 1] : null;

const scanRoots = ["src", "test", "e2e", "scripts"];
const skip = /(^|\/)(node_modules|analysis|fixtures)(\/|$)/;
const extensions = new Set([".ts", ".tsx", ".mjs", ".js"]);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (skip.test(rel)) continue;
		if (entry.isDirectory()) out.push(...walk(rel));
		else if (extensions.has(path.extname(entry.name))) out.push(rel);
	}
	return out;
}

const files = scanRoots.filter((dir) => statSync(path.join(root, dir), { throwIfNoEntry: false })).flatMap(walk);
const sources = new Map(
	files.map((file) => {
		const text = readFileSync(path.join(root, file), "utf8");
		const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
		return [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)];
	}),
);

function visit(node, fn) {
	fn(node);
	ts.forEachChild(node, (child) => visit(child, fn));
}

// ---- canonical declarations -------------------------------------------------

function constArrayMembers(file, name) {
	const members = [];
	visit(sources.get(file), (node) => {
		if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer) {
			visit(node.initializer, (inner) => {
				if (ts.isStringLiteral(inner)) members.push(inner.text);
			});
		}
	});
	return members;
}

function unionMembers(file, typeName, property = null) {
	const members = [];
	visit(sources.get(file), (node) => {
		if (!ts.isTypeAliasDeclaration(node) || node.name.text !== typeName) return;
		visit(node.type, (inner) => {
			if (property === null && ts.isLiteralTypeNode(inner) && ts.isStringLiteral(inner.literal)) {
				members.push(inner.literal.text);
			}
			if (
				property !== null &&
				ts.isPropertySignature(inner) &&
				inner.name.getText() === property &&
				inner.type &&
				ts.isLiteralTypeNode(inner.type) &&
				ts.isStringLiteral(inner.type.literal)
			) {
				members.push(inner.type.literal.text);
			}
		});
	});
	return [...new Set(members)];
}

function objectKeys(file, name) {
	const keys = [];
	visit(sources.get(file), (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === name &&
			node.initializer &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			for (const property of node.initializer.properties) {
				if (property.name && ts.isStringLiteral(property.name)) keys.push(property.name.text);
			}
		}
	});
	return keys;
}

/** Tries canonical declarations in order, so older revisions stay measurable. */
function firstDeclared(...candidates) {
	for (const [file, read] of candidates) {
		if (!sources.has(file)) continue;
		const members = read(file);
		if (members.length) return { declaredIn: file, members };
	}
	return { declaredIn: "(not found)", members: [] };
}

function interfaceKeys(file, name) {
	let keys = [];
	visit(sources.get(file), (node) => {
		if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
			keys = node.members.filter(ts.isPropertySignature).map((member) => member.name.getText());
		}
	});
	return keys;
}

/**
 * Server routes: `app.<method>("/path")` calls in the entry file, plus route
 * declarations anywhere in src written as `{ method: "X", path: "/api/..." }`.
 */
function serverRoutes(entryFile) {
	const routes = [];
	visit(sources.get(entryFile), (node) => {
		if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
		const method = node.expression.name.text;
		if (node.expression.expression.getText() !== "app") return;
		if (!["get", "post", "put", "delete", "patch"].includes(method)) return;
		const [first] = node.arguments;
		if (first && ts.isStringLiteral(first) && first.text.startsWith("/")) {
			routes.push(`${method.toUpperCase()} ${first.text}`);
		}
	});
	for (const [file, source] of sources) {
		if (!file.startsWith("src/")) continue;
		visit(source, (node) => {
			if (!ts.isObjectLiteralExpression(node)) return;
			const value = (name) => {
				const property = node.properties.find(
					(p) => ts.isPropertyAssignment(p) && p.name.getText() === name,
				);
				return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
			};
			const method = value("method");
			const routePath = value("path") ?? value("pattern");
			if (method && routePath?.startsWith("/api/")) routes.push(`${method.toUpperCase()} ${routePath}`);
		});
	}
	return [...new Set(routes)];
}

// ---- occurrence scanning ----------------------------------------------------

/** Every string the file spells out: literals and templates with ${} -> ":param". */
function literalsIn(file) {
	const out = [];
	visit(sources.get(file), (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			out.push({ text: node.text, line: lineOf(file, node) });
		} else if (ts.isTemplateExpression(node)) {
			const text = node.head.text + node.templateSpans.map((span) => `:param${span.literal.text}`).join("");
			out.push({ text, line: lineOf(file, node) });
		}
	});
	return out;
}

function lineOf(file, node) {
	return sources.get(file).getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

const literalCache = new Map(files.map((file) => [file, literalsIn(file)]));

function exactSites(member) {
	const sites = [];
	for (const [file, literals] of literalCache) {
		const lines = literals.filter((literal) => literal.text === member).map((literal) => literal.line);
		if (lines.length) sites.push({ file, lines });
	}
	return sites;
}

function routeSites(route) {
	const [, pattern] = route.split(" ");
	const regex = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, "[^/?]+")}(\\?.*)?$`);
	const sites = [];
	for (const [file, literals] of literalCache) {
		const lines = literals
			.filter((literal) => literal.text.startsWith("/api") && regex.test(literal.text))
			.map((literal) => literal.line);
		if (lines.length) sites.push({ file, lines });
	}
	return sites;
}

/**
 * Shape declarations: interfaces, type literals and z.object({...}) calls whose
 * keys cover the record's identifying keys. Each is an independent restatement.
 */
function shapeSites(keys) {
	const required = new Set(keys);
	const sites = [];
	for (const [file, source] of sources) {
		const lines = [];
		visit(source, (node) => {
			let names = null;
			if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
				names = node.members.filter((m) => m.name).map((m) => m.name.getText());
			} else if (
				ts.isCallExpression(node) &&
				node.expression.getText().endsWith(".object") &&
				node.arguments[0] &&
				ts.isObjectLiteralExpression(node.arguments[0])
			) {
				names = node.arguments[0].properties.filter((p) => p.name).map((p) => p.name.getText());
			}
			if (names && [...required].every((key) => names.includes(key))) lines.push(lineOf(file, node));
		});
		if (lines.length) sites.push({ file, lines });
	}
	return sites;
}

// ---- families ---------------------------------------------------------------

const families = [
	{
		name: "account-command",
		...firstDeclared(
			["src/lib/api/account-commands.ts", (file) => objectKeys(file, "ACCOUNT_COMMANDS")],
			["src/lib/sync/contracts.ts", (file) => constArrayMembers(file, "ACCOUNT_COMMAND_TYPES")],
		),
		sites: exactSites,
	},
	{
		name: "command-effect",
		declaredIn: "src/lib/sync/contracts.ts#AccountCommandEffect",
		members: unionMembers("src/lib/sync/contracts.ts", "AccountCommandEffect", "type"),
		sites: exactSites,
	},
	{
		name: "terminal-replay-reason",
		declaredIn: "src/lib/sync/contracts.ts#TerminalReplayReason",
		members: unionMembers("src/lib/sync/contracts.ts", "TerminalReplayReason"),
		sites: exactSites,
	},
	{
		name: "api-error-code",
		declaredIn: "src/lib/api/errors.ts#API_ERROR_CODES",
		members: constArrayMembers("src/lib/api/errors.ts", "API_ERROR_CODES"),
		sites: exactSites,
	},
	{
		name: "sync-message",
		declaredIn: "src/types/account.ts#SyncMessage",
		// "sync" and "error" are too generic to grep meaningfully.
		members: unionMembers("src/types/account.ts", "SyncMessage", "type").filter((m) => !["sync", "error"].includes(m)),
		sites: exactSites,
	},
	{
		name: "http-route",
		declaredIn: "src/index.tsx#app.<method>() + { method, path } declarations",
		members: serverRoutes("src/index.tsx"),
		sites: routeSites,
	},
	{
		name: "record-shape",
		declaredIn: "src/types/account.ts interfaces",
		members: ["Account", "ColumnMeta", "DeletedColumn"],
		sites: (member) => shapeSites(interfaceKeys("src/types/account.ts", member)),
	},
];

const report = families
	.filter((family) => !familyFilter || family.name === familyFilter)
	.map((family) => {
		const members = family.members.map((member) => {
			const sites = family.sites(member);
			return {
				member,
				files: sites.length,
				srcFiles: sites.filter((site) => site.file.startsWith("src/")).length,
				occurrences: sites.reduce((sum, site) => sum + site.lines.length, 0),
				sites,
			};
		});
		const footprint = new Set(members.flatMap((m) => m.sites.map((s) => s.file)));
		return {
			family: family.name,
			declaredIn: family.declaredIn,
			memberCount: members.length,
			footprintFiles: footprint.size,
			footprintSrcFiles: [...footprint].filter((file) => file.startsWith("src/")).length,
			medianSrcFilesPerMember: median(members.map((m) => m.srcFiles)),
			members,
		};
	});

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	for (const family of report) {
		console.log(
			`\n## ${family.family} (${family.memberCount} members, declared in ${family.declaredIn})` +
				`\n   footprint: ${family.footprintSrcFiles} src files / ${family.footprintFiles} total; median src files per member: ${family.medianSrcFilesPerMember}`,
		);
		for (const member of family.members) {
			const where = member.sites.map((site) => `${site.file}(${site.lines.length})`).join(", ");
			console.log(`   ${member.member.padEnd(42)} src=${member.srcFiles} all=${member.files}  ${where}`);
		}
	}
}
