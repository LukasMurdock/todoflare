// Host 1: the smallest useful embed. One import, no account, no server.
// Content is kept in memory and mirrored to localStorage as Plate JSON.
import { createRoot } from "react-dom/client";
import type { Value } from "platejs";
import { TodoBoard, createMemoryDocuments, useLocalBoard } from "../api";

const STORAGE_KEY = "my-app-board";
const saved: Record<string, Value> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
const documents = createMemoryDocuments(saved);

function App() {
	const { boardProps } = useLocalBoard(Object.keys(saved).map((id) => ({ id, removal: "delete" })));
	return (
		<TodoBoard
			{...boardProps}
			documents={documents}
			onContentChange={(columnId, content) => {
				saved[columnId] = content;
				localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
			}}
		/>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
