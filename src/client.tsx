import "./styles/global.css";
import { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TodoApp } from "./components/todo/TodoApp";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import { WelcomeScreen } from "./components/welcome-screen";
import { WelcomeRefsProvider } from "./contexts/welcome-refs-context";
import { SyncProvider, useSyncContext } from "./contexts/sync-context";
import { AccountModal } from "./components/account/AccountModal";
import { ClaimDataModal } from "./components/account/ClaimDataModal";
import { PublicView } from "./components/public/PublicView";
import { useFirstVisit } from "./hooks/useFirstVisit";

/**
 * Simple router based on pathname
 */
function useRoute() {
	const [pathname, setPathname] = useState(window.location.pathname);

	useEffect(() => {
		const handlePopState = () => setPathname(window.location.pathname);
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	return useMemo(() => {
		// Match /p/:publicId for public view
		const publicMatch = pathname.match(/^\/p\/([a-zA-Z0-9]+)$/);
		if (publicMatch) {
			return { type: "public" as const, publicId: publicMatch[1] };
		}

		// Default to main app
		return { type: "app" as const };
	}, [pathname]);
}

function AppContent() {
	const { isFirstVisit, dismissWelcome } = useFirstVisit();
	const { accountId, hasLocalData, isLoading } = useSyncContext();

	const [showAccountModal, setShowAccountModal] = useState(false);
	const [showClaimModal, setShowClaimModal] = useState(false);

	// Determine which modal to show on first load
	useEffect(() => {
		if (isLoading) return;

		// If no account is logged in
		if (!accountId) {
			const hasData = hasLocalData();
			if (hasData) {
				// Has local data - show claim modal
				setShowClaimModal(true);
			} else {
				// No local data - show account modal
				setShowAccountModal(true);
			}
		}
	}, [accountId, hasLocalData, isLoading]);

	return (
		<WelcomeRefsProvider>
			<TodoApp />
			<KeyboardShortcuts />
			{isFirstVisit && <WelcomeScreen onDismiss={dismissWelcome} />}

			<AccountModal
				open={showAccountModal}
				onOpenChange={setShowAccountModal}
			/>

			<ClaimDataModal
				open={showClaimModal}
				onOpenChange={setShowClaimModal}
			/>

			<Toaster position="bottom-right" richColors />
		</WelcomeRefsProvider>
	);
}

function App() {
	const route = useRoute();

	// Public view doesn't need SyncProvider (has its own WebSocket handling)
	if (route.type === "public") {
		return (
			<>
				<PublicView publicId={route.publicId} />
				<Toaster position="bottom-right" richColors />
			</>
		);
	}

	return (
		<SyncProvider>
			<AppContent />
		</SyncProvider>
	);
}

createRoot(document.getElementById("root")!).render(
	<App />,
);
