// The smallest useful host: one import, no account, no server. Content lives
// in memory and is mirrored to localStorage as Plate JSON.
//
// Query flags turn on adversarial setups for the host tests:
//   ?two      two boards on one page    ?strict   React StrictMode
//   ?hostile  aggressive global CSS     ?failing  an adapter that rejects
//   ?cycles   mount/unmount on demand
import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ElementApi } from 'platejs';
import type { Value } from 'platejs';
import { createPlatePlugin } from "platejs/react";
import { TodoBoard, createMemoryDocuments } from '@todoflare/board';
import type { BoardColumn, DocumentAdapter, TodoBoardApi } from '@todoflare/board';
import "@todoflare/board/board.css";

const flags = new URLSearchParams(location.search);

// A host editor plugin: Alt+D inserts a stamp.
const stampPlugin = createPlatePlugin({
	key: "hostStamp",
	handlers: {
		onKeyDown: ({ editor, event }) => {
			if (!event.altKey || event.code !== "KeyD") {return;}
			event.preventDefault();
			editor.tf.insertText("[stamp]");
			return true;
		},
	},
});
const editorPlugins = [stampPlugin];

const failingDocuments: DocumentAdapter = {
	open: () => Promise.reject(new Error("storage offline")),
};

function readSavedColumns(key: string) {
	const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
	if (!raw || typeof raw !== "object") {throw new Error("Invalid saved columns");}
	const columns = new Map<string, Value>();
	for (const [id, snapshot] of Object.entries(raw)) {
		if (!ElementApi.isElementList(snapshot)) {throw new Error("Invalid column snapshot");}
		columns.set(id, snapshot);
	}
	return columns;
}

function useSavedColumns(key: string) {
	const [columns, setColumns] = useState<Array<BoardColumn>>(() => {
		const entries = [...readSavedColumns(key)];
		return entries.length
			? entries.map(([id, snapshot]) => ({ id, snapshot, removal: "delete" }))
			: [{ id: crypto.randomUUID(), removal: "delete" }];
	});
	const save = (columnId: string, content: Value) => {
		const saved = readSavedColumns(key);
		saved.set(columnId, content);
		localStorage.setItem(key, JSON.stringify(Object.fromEntries(saved)));
	};
	return { columns, setColumns, save };
}

function Board({ name }: { name: string }) {
	const { columns, setColumns, save } = useSavedColumns(`board:${name}`);
	const documents = useMemo(() => (flags.has("failing") ? failingDocuments : createMemoryDocuments()), []);
	const board = useRef<TodoBoardApi>(null);
	const [log, setLog] = useState<Array<string>>([]);
	const note = (line: string) => setLog((lines) => [...lines, line]);

	return (
		<section aria-label={`Board ${name}`} style={{ display: "flex", flexDirection: "column", height: 420, border: "1px solid #ccc" }}>
			<div style={{ display: "flex", gap: 8, padding: 4 }}>
				<button type="button" onClick={() => note(`focus:${board.current?.focusColumn(columns[0].id)}`)}>Focus first</button>
				<button type="button" onClick={() => note(`content:${JSON.stringify(board.current?.getColumnContent(columns[0].id))}`)}>Read first</button>
				<button type="button" onClick={() => { const last = columns.at(-1); if (last) {board.current?.scrollToColumn(last.id);} }}>Scroll to last</button>
			</div>
			{/* layout="fill" (the default) fills this box; columns scroll inside it. */}
			<div style={{ flex: 1, minHeight: 0 }}>
			<TodoBoard
				ref={board}
				columns={columns}
				documents={documents}
				editorPlugins={editorPlugins}
				onCreateColumn={() => setColumns((list) => [...list, { id: crypto.randomUUID(), removal: "delete" }])}
				onRemoveColumn={(column) => setColumns((list) => list.filter((c) => c.id !== column.id))}
				onReorderColumns={(ids) => setColumns((list) => ids.flatMap((id) => list.filter((column) => column.id === id)))}
				onCollapsedChange={(column, collapsed) =>
					setColumns((list) => list.map((c) => (c.id === column.id ? { ...c, collapsed } : c)))
				}
				onContentChange={save}
				onOpenLink={(url) => note(`link:${url}`)}
				onError={(error, context) => note(`error:${context.operation}:${error instanceof Error ? error.message : String(error)}`)}
			/>
			</div>
			<output aria-label={`Log ${name}`} style={{ whiteSpace: "pre" }}>{log.join("\n")}</output>
		</section>
	);
}

function Cycles() {
	const [mounted, setMounted] = useState(true);
	return (
		<>
			<button type="button" onClick={() => setMounted((value) => !value)}>Toggle board</button>
			{mounted && <Board name="cycled" />}
		</>
	);
}

function App() {
	if (flags.has("cycles")) {return <Cycles />;}
	return (
		<main>
			<Board name="a" />
			{flags.has("two") && <Board name="b" />}
		</main>
	);
}

if (flags.has("hostile")) {
	const style = document.createElement("style");
	style.textContent = `
		* { font-family: serif; box-sizing: content-box; margin: 4px; }
		button { all: unset; color: red; }
		div { line-height: 3; }
		ul, ol { list-style: square; padding-left: 60px; }
		h1 { font-size: 64px; }
	`;
	document.head.append(style);
}

const app = flags.has("strict") ? (
	<StrictMode>
		<App />
	</StrictMode>
) : (
	<App />
);
const root = document.getElementById("root");
if (!root) {throw new Error("Missing board host");}
createRoot(root).render(app);
