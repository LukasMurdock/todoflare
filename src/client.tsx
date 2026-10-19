import "./styles/global.css";
import { lazy, Suspense, useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TodoApp } from "./components/todo/TodoApp";
import { WelcomeScreen } from "./components/welcome-screen";
import { WelcomeRefsProvider } from "./contexts/welcome-refs-context";
import { SyncProvider, useSyncContext } from "./contexts/sync-context";
import { AccountModal } from "./components/account/AccountModal";
import { ClaimDataModal } from "./components/account/ClaimDataModal";
import { PublicView } from "./components/public/PublicView";
import { useFirstVisit } from "./hooks/useFirstVisit";
import { isOAuthAuthorizePagePath, matchPublicPagePath } from "./lib/api/routes";
// Only the OAuth authorization endpoint renders it.
const OAuthConsentPage = lazy(() => import("./components/agents/OAuthConsentPage").then((module) => ({ default: module.OAuthConsentPage })));

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
		const publicId = matchPublicPagePath(pathname);
		if (publicId) {
			return { type: "public" as const, publicId };
		}
		if (isOAuthAuthorizePagePath(pathname)) return { type: "oauth" as const };

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

	// Consent needs the account session, but not the board or its onboarding.
	if (route.type === "oauth") {
		return (
			<SyncProvider>
				<Suspense fallback={null}>
					<OAuthConsentPage />
				</Suspense>
				<Toaster position="bottom-right" richColors />
			</SyncProvider>
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
