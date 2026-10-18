import { useState } from "react";
import { useAccount } from "@/hooks/useAccount";
import { Button } from "@/components/ui/button";
import { displayAccountId } from "@/lib/account";

export function ReconnectBanner() {
	const { accountId, authenticationStatus, isReconnecting, loginWithPasskey, error } = useAccount();
	const [busy, setBusy] = useState(false);
	if (!accountId || authenticationStatus !== "required") return null;

	const reconnect = async () => {
		setBusy(true);
		try { await loginWithPasskey(); }
		finally { setBusy(false); }
	};

	return (
		<div role="alert" className="relative z-40 flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-50 px-4 py-3 pr-28 text-sm dark:bg-amber-950">
			<div className="space-y-1">
				<p className="font-medium">Sign-in required to resume syncing</p>
				<p>Unlock account {displayAccountId(accountId)} with its passkey. Your local data and queued edits are kept while you reconnect.</p>
				{error && error !== "Sign in with a passkey to resume syncing" && <p className="text-destructive">{error}</p>}
			</div>
			<Button size="sm" disabled={busy || isReconnecting} onClick={() => void reconnect()}>
				{busy || isReconnecting ? "Reconnecting..." : "Reconnect with a passkey"}
			</Button>
		</div>
	);
}
