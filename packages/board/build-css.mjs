// Builds dist/board.css: the board's prebuilt stylesheet for hosts that do not
// compile Tailwind themselves.
//
// Usage: node build-css.mjs
//
// The stylesheet must hold up inside someone else's page:
// - Tokens are declared on [data-todo-board] (src/styles/tokens.css), not :root.
// - Tailwind's preflight is rewritten to apply only inside the board and kept
//   outside cascade layers, with selectors like `[data-todo-board] button`, so
//   it beats a host's element and universal rules (layered rules would lose to
//   any unlayered host rule).
// - Utilities are compiled `!important`, so they beat the scoped preflight and
//   a host's own rules.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const ROOT = "[data-todo-board]";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Splits a selector list on top-level commas (not those inside :is(...)). */
function splitSelectors(list) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const char of list) {
		if (char === "(" || char === "[") depth++;
		if (char === ")" || char === "]") depth--;
		if (char === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
		} else current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function scopeSelector(selector) {
	if (/^(html|:host|body)$/.test(selector)) return [ROOT];
	// Universal rules apply to the root itself and everything inside it.
	if (selector === "*" || selector.startsWith("::")) return [`${ROOT}${selector === "*" ? "" : selector}`, `${ROOT} ${selector}`];
	return [`${ROOT} ${selector}`];
}

/** Rewrites every rule of a stylesheet to apply only inside the board, dropping @layer wrappers. */
export function scopeStylesheet(css) {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	let out = "";
	let index = 0;
	while (index < text.length) {
		const open = text.indexOf("{", index);
		if (open === -1) break;
		const prelude = text.slice(index, open).trim();
		let depth = 1;
		let close = open + 1;
		while (depth > 0) {
			if (text[close] === "{") depth++;
			if (text[close] === "}") depth--;
			close++;
		}
		const body = text.slice(open + 1, close - 1);
		if (prelude.startsWith("@layer")) out += scopeStylesheet(body);
		else if (prelude.startsWith("@")) out += `${prelude} {\n${scopeStylesheet(body)}}\n`;
		else out += `${splitSelectors(prelude).flatMap(scopeSelector).join(",\n")} {${body}}\n`;
		index = close;
	}
	return out;
}

const preflight = scopeStylesheet(readFileSync(require.resolve("tailwindcss/preflight.css"), "utf8"));

// A host's universal and element rules (`* { font-family: serif }`, `div { line-height: 3 }`)
// would otherwise reach every element in the board. Placed before the scoped
// preflight, whose more specific rules (and all utilities) still win.
const inheritFromRoot = `${ROOT} *, ${ROOT} ::before, ${ROOT} ::after {
	font-family: inherit;
	font-size: inherit;
	line-height: inherit;
	letter-spacing: inherit;
	color: inherit;
}
`;

const entry = `
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) important;
@import "tw-animate-css";
@plugin "tailwind-scrollbar-hide";
@import "./src/styles/tailwind.css";
@source "./src";

${ROOT} {
	font-family: var(--default-font-family);
	line-height: 1.5;
	color: var(--color-foreground);
	background-color: var(--color-background);
	-webkit-text-size-adjust: 100%;
	tab-size: 4;
}
${ROOT}, ${ROOT} * {
	border-color: var(--color-border);
	outline-color: color-mix(in oklab, var(--color-ring) 50%, transparent);
}
`;

const compiler = await compile(entry, { base: here, onDependency() {} });
const scanner = new Scanner({ sources: [{ base: path.join(here, "src"), pattern: "**/*", negated: false }] });
const built = compiler.build(scanner.scan());
const { code } = optimize(`${inheritFromRoot}\n${preflight}\n${built}`, { minify: false });

mkdirSync(path.join(here, "dist"), { recursive: true });
writeFileSync(path.join(here, "dist/board.css"), code);
console.log(`dist/board.css: ${(Buffer.byteLength(code) / 1024).toFixed(1)} KiB`);
