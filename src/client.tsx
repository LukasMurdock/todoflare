import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TodoApp } from "./components/todo/TodoApp";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import { WelcomeScreen } from "./components/welcome-screen";
import { WelcomeRefsProvider } from "./contexts/welcome-refs-context";
import { useFirstVisit } from "./hooks/useFirstVisit";

function App() {
	const { isFirstVisit, dismissWelcome } = useFirstVisit();

	return (
		<WelcomeRefsProvider>
			<TodoApp />
			<KeyboardShortcuts />
			{isFirstVisit && <WelcomeScreen onDismiss={dismissWelcome} />}
		</WelcomeRefsProvider>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>
);
