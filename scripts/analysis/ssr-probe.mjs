// SSR probe: can the board be imported and rendered on a server?
//
// Usage: node scripts/analysis/ssr-probe.mjs [--json]
//
// Loads every module of the board package with Vite's SSR loader in
// plain Node, where window, document and localStorage do not exist, then tries
// to render the board entry points to HTML. Server-rendering hosts (Void
// islands, Next.js) need both to succeed.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { BOARD_ROOT } from "./board-zones.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asJson = process.argv.includes("--json");

function walk(dir) {
	return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const rel = `${dir}/${entry.name}`;
		return entry.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
	});
}

const server = await createServer({
	root,
	configFile: false,
	logLevel: "silent",
	appType: "custom",
	server: { middlewareMode: true, hmr: false, ws: false },
	resolve: { alias: { "@": path.join(root, "src") } },
	define: { __TODOFLARE_E2E__: "false" },
	ssr: { noExternal: [] },
});

const firstLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 160);
const imports = [];
for (const file of walk(BOARD_ROOT).sort()) {
	try {
		await server.ssrLoadModule(`/${file}`);
		imports.push({ file, ok: true });
	} catch (error) {
		imports.push({ file, ok: false, error: firstLine(error) });
	}
}

// Dependencies are externalized, so the board and this script share Node's React instance.
const { createElement: h } = await import("react");
const { renderToString } = await import("react-dom/server");
const snapshot = [
	{ type: "h1", children: [{ text: "Server heading" }] },
	{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "Rendered todo" }] },
];
const column = { id: "00000000-0000-4000-8000-000000000001", snapshot };
const renders = [];
async function tryRender(name, load, expectText) {
	try {
		const html = renderToString(await load());
		const missing = expectText.filter((text) => !html.includes(text));
		renders.push(missing.length ? { name, ok: false, error: `HTML lacks ${missing.join(", ")}` } : { name, ok: true, htmlBytes: html.length });
	} catch (error) {
		renders.push({ name, ok: false, error: firstLine(error) });
	}
}
const { createMemoryDocuments } = await server.ssrLoadModule("/packages/board/src/index.ts");
await tryRender(
	"TodoBoard (memory documents, snapshot)",
	async () => h((await server.ssrLoadModule("/packages/board/src/index.ts")).TodoBoard, { columns: [column], documents: createMemoryDocuments(), onCreateColumn() {} }),
	["Server heading", "Rendered todo", "Add column", "data-todo-board"],
);
await tryRender(
	"TodoBoard (loading)",
	async () => h((await server.ssrLoadModule("/packages/board/src/index.ts")).TodoBoard, { status: "loading", columns: [column], documents: createMemoryDocuments() }),
	['aria-busy="true"'],
);
await tryRender(
	"ColumnSnapshot",
	async () => h((await server.ssrLoadModule("/packages/board/src/index.ts")).ColumnSnapshot, { value: snapshot }),
	["Server heading", "Rendered todo"],
);

await server.close();
const report = { imports, importFailures: imports.filter((i) => !i.ok).length, renders };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
	console.log(`## Import in Node (${imports.length - report.importFailures}/${imports.length} ok)`);
	for (const i of imports.filter((i) => !i.ok)) console.log(`  FAIL ${i.file}: ${i.error}`);
	console.log("\n## Server render");
	for (const r of renders) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? ` (${r.htmlBytes} bytes)` : `: ${r.error}`}`);
}
