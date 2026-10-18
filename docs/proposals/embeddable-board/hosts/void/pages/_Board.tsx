// Host 3 (adversarial): a Void page on Cloudflare Workers. The board is server
// rendered as an island and hydrated on load, so it must render without window,
// localStorage or IndexedDB, then pick up from the server snapshot.
import type { Value } from "platejs";
import { TodoBoard, createMemoryDocuments, useLocalBoard, type BoardColumn } from "../../../api";

export interface BoardIslandProps {
	columns: { id: string; content: Value }[];
}

export default function BoardIsland({ columns }: BoardIslandProps) {
	const initial: BoardColumn[] = columns.map(({ id, content }) => ({ id, snapshot: content, removal: "delete" }));
	const { boardProps } = useLocalBoard(initial);
	const documents = createMemoryDocuments();
	return <TodoBoard {...boardProps} documents={documents} />;
}
