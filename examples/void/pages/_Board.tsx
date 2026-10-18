// The board as a Void island: rendered to HTML on the server (Workers runtime,
// no window, localStorage or IndexedDB), then hydrated in the browser.
import { useState } from "react";
import type { Value } from "platejs";
import { TodoBoard, createMemoryDocuments, type BoardColumn } from "@todoflare/board";

export interface BoardIslandProps {
	columns: { id: string; content: Value }[];
}

export default function BoardIsland({ columns: initial }: BoardIslandProps) {
	const [columns, setColumns] = useState<BoardColumn[]>(() =>
		initial.map(({ id, content }) => ({ id, snapshot: content, removal: "delete" })),
	);
	const [documents] = useState(createMemoryDocuments);
	return (
		<div style={{ height: 480 }}>
			<TodoBoard
				// Void renders the island inside the page but hydrates it as its own root.
				id="team-board"
				columns={columns}
				documents={documents}
				onCreateColumn={() => setColumns((list) => [...list, { id: crypto.randomUUID(), removal: "delete" }])}
				onRemoveColumn={(column) => setColumns((list) => list.filter((c) => c.id !== column.id))}
				onReorderColumns={(ids) => setColumns((list) => ids.map((id) => list.find((c) => c.id === id)!))}
				onCollapsedChange={(column, collapsed) =>
					setColumns((list) => list.map((c) => (c.id === column.id ? { ...c, collapsed } : c)))
				}
			/>
		</div>
	);
}
