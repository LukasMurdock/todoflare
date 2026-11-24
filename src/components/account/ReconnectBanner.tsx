import { useState } from "react";
import { useAccount } from "@/hooks/useAccount";
import { Fingerprint, KeyRound } from "lucide-react";
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
		<div
			role="alert"
			className="relative z-40 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-b border-amber-500/30 bg-amber-50/95 px-4 py-2.5 text-[13px] backdrop-blur-md sm:grid-cols-[auto_1fr_auto] sm:pr-36 dark:bg-amber-950/80"
		>
			<span className="flex size-7 items-center justify-center self-start rounded-md bg-amber-500/15 text-amber-700 sm:self-center dark:text-amber-300">
				<KeyRound className="size-4 stroke-[1.75]" />
			</span>
			<div className="min-w-0 space-y-0.5">
				<p className="font-medium">Sign-in required to resume syncing</p>
				<p className="text-muted-foreground">
					Unlock account{" "}
					<span className="rounded bg-background/70 px-1 py-px font-mono text-[12px] tracking-[0.04em] text-foreground tabular-nums">
						{displayAccountId(accountId)}
					</span>{" "}
					with its passkey. Your local data and queued edits are kept while you reconnect.
				</p>
				{error && error !== "Sign in with a passkey to resume syncing" && <p className="text-red-600 dark:text-red-400">{error}</p>}
			</div>
			<Button size="sm" className="max-sm:col-span-2 max-sm:w-full" disabled={busy || isReconnecting} onClick={() => void reconnect()}>
				<Fingerprint className="stroke-[1.75]" />
				{busy || isReconnecting ? "Reconnecting..." : "Reconnect with a passkey"}
			</Button>
		</div>
	);
}
