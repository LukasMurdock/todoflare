import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TodoApp } from "./components/todo/TodoApp";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TodoApp />
		<KeyboardShortcuts />
	</StrictMode>
);
