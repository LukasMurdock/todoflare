// The smallest useful host: one import, no account, no server. Content lives
// in memory and is mirrored to localStorage as Plate JSON.
//
// Query flags turn on adversarial setups for the host tests:
//   ?two      two boards on one page    ?strict   React StrictMode
//   ?hostile  aggressive global CSS     ?failing  an adapter that rejects
//   ?cycles   mount/unmount on demand
import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Value } from "platejs";
import { createPlatePlugin } from "platejs/react";
import {
	TodoBoard,
	createMemoryDocuments,
	type BoardColumn,
	type DocumentAdapter,
	type TodoBoardApi,
} from "@todoflare/board";
import "@todoflare/board/board.css";

const flags = new URLSearchParams(location.search);

// A host editor plugin: Alt+D inserts a stamp.
const stampPlugin = createPlatePlugin({
	key: "hostStamp",
	handlers: {
		onKeyDown: ({ editor, event }) => {
			if (!event.altKey || event.code !== "KeyD") return;
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

function useSavedColumns(key: string) {
	const [columns, setColumns] = useState<BoardColumn[]>(() => {
		const saved: Record<string, Value> = JSON.parse(localStorage.getItem(key) ?? "{}");
		const entries = Object.entries(saved);
		return entries.length
			? entries.map(([id, snapshot]) => ({ id, snapshot, removal: "delete" }))
			: [{ id: crypto.randomUUID(), removal: "delete" }];
	});
	const save = (columnId: string, content: Value) => {
		const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
		saved[columnId] = content;
		localStorage.setItem(key, JSON.stringify(saved));
	};
	return { columns, setColumns, save };
}

function Board({ name }: { name: string }) {
	const { columns, setColumns, save } = useSavedColumns(`board:${name}`);
	const documents = useMemo(() => (flags.has("failing") ? failingDocuments : createMemoryDocuments()), []);
	const board = useRef<TodoBoardApi>(null);
	const [log, setLog] = useState<string[]>([]);
	const note = (line: string) => setLog((lines) => [...lines, line]);

	return (
		<section aria-label={`Board ${name}`} style={{ display: "flex", flexDirection: "column", height: 420, border: "1px solid #ccc" }}>
			<div style={{ display: "flex", gap: 8, padding: 4 }}>
				<button type="button" onClick={() => note(`focus:${board.current?.focusColumn(columns[0]!.id)}`)}>Focus first</button>
				<button type="button" onClick={() => note(`content:${JSON.stringify(board.current?.getColumnContent(columns[0]!.id))}`)}>Read first</button>
				<button type="button" onClick={() => board.current?.scrollToColumn(columns.at(-1)!.id)}>Scroll to last</button>
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
				onReorderColumns={(ids) => setColumns((list) => ids.map((id) => list.find((c) => c.id === id)!))}
				onCollapsedChange={(column, collapsed) =>
					setColumns((list) => list.map((c) => (c.id === column.id ? { ...c, collapsed } : c)))
				}
				onContentChange={save}
				onOpenLink={(url) => note(`link:${url}`)}
				onError={(error, context) => note(`error:${context.operation}:${(error as Error).message}`)}
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
	if (flags.has("cycles")) return <Cycles />;
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
createRoot(document.getElementById("root")!).render(app);
