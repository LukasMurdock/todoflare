// Fails when an API or public-page path is spelled out as a string literal
// outside the route declarations. Routes the browser and Worker share belong
// in src/lib/api/routes.ts (or account-commands.ts), so a path or method can
// only change in one place. Server-only admin routes are exempt.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeModules = new Set(["src/lib/api/routes.ts", "src/lib/api/account-commands.ts"]);
const routeLiteral = /^\/(api|p)\//;
const allowed = (text) => text === "/api/*" || text === "/api/auth/*" || text.startsWith("/api/admin/");
// better-auth's prefix; a template built on it spells out an auth path.
const AUTH_BASE_PATH = { name: "AUTH_BASE_PATH", value: "/api/auth" };

function sourceFiles(dir) {
	return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) return sourceFiles(rel);
		return /\.tsx?$/.test(entry.name) ? [rel] : [];
	});
}

export function findRouteLiterals(fileName, text) {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
	const found = [];
	const visit = (node) => {
		let literal = null;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text;
		else if (ts.isTemplateExpression(node)) {
			const [first] = node.templateSpans;
			literal = node.head.text === "" && ts.isIdentifier(first.expression) && first.expression.text === AUTH_BASE_PATH.name
				? AUTH_BASE_PATH.value + first.literal.text
				: node.head.text;
		}
		if (literal !== null && routeLiteral.test(literal) && !allowed(literal)) {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart());
			found.push(`${fileName}:${line + 1}  ${literal}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

// Self-check: the rule must still catch the patterns it exists to prevent.
const probe = findRouteLiterals("probe.ts", 'fetch("/api/account"); fetch(`/api/column/${id}/ws`); go(`/p/${publicId}`); fetch(`${AUTH_BASE_PATH}/recovery-code/generate`);');
if (probe.length !== 4) {
	console.error("check-route-literals self-check failed:", probe);
	process.exit(1);
}

const violations = sourceFiles("src")
	.filter((file) => !routeModules.has(file))
	.flatMap((file) => findRouteLiterals(file, readFileSync(path.join(root, file), "utf8")));

if (violations.length) {
	console.error("Route paths must come from src/lib/api/routes.ts or account-commands.ts:");
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
console.log("Route literals are declared only in the route modules.");
