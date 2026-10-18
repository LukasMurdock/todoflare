// SSR probe: can the board be imported and rendered on a server?
//
// Usage: node scripts/analysis/ssr-probe.mjs [--json]
//
// Loads every board module (see ./board-zones.mjs) with Vite's SSR loader in
// plain Node, where window, document and localStorage do not exist, then tries
// to render the board entry points to HTML. Server-rendering hosts (Void
// islands, Next.js) need both to succeed.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { zoneOf } from "./board-zones.mjs";

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
for (const file of walk("src").filter((f) => zoneOf(f) === "board").sort()) {
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
const column = { id: "00000000-0000-4000-8000-000000000001", value: [{ type: "p", children: [{ text: "Hello" }] }] };
const renders = [];
async function tryRender(name, load) {
	try {
		const html = renderToString(await load());
		renders.push({ name, ok: true, htmlBytes: html.length });
	} catch (error) {
		renders.push({ name, ok: false, error: firstLine(error) });
	}
}
await tryRender("TodoApp (no providers)", async () => h((await server.ssrLoadModule("/src/components/todo/TodoApp.tsx")).TodoApp));
await tryRender("ColumnLayout (props only)", async () => {
	const { ColumnLayout } = await server.ssrLoadModule("/src/components/todo/ColumnLayout.tsx");
	const noop = () => {};
	return h(ColumnLayout, { columns: [column], onAdd: noop, onUpdate: noop, onRemove: noop, onToggleCollapse: noop });
});
await tryRender("TodoColumn (props only)", async () => {
	const { TodoColumn } = await server.ssrLoadModule("/src/components/todo/TodoColumn.tsx");
	const noop = () => {};
	return h(TodoColumn, { column, onUpdate: noop, onRemove: noop, onToggleCollapse: noop, canRemove: false });
});

await server.close();
const report = { imports, importFailures: imports.filter((i) => !i.ok).length, renders };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
	console.log(`## Import in Node (${imports.length - report.importFailures}/${imports.length} ok)`);
	for (const i of imports.filter((i) => !i.ok)) console.log(`  FAIL ${i.file}: ${i.error}`);
	console.log("\n## Server render");
	for (const r of renders) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? ` (${r.htmlBytes} bytes)` : `: ${r.error}`}`);
}
