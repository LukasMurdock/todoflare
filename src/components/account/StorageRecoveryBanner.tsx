import { useState } from "react";
import { useSyncContext } from "@/contexts/sync-context";
import { Button } from "@/components/ui/button";

export function StorageRecoveryBanner() {
	const { accountId, browserStorageError, syncStateSummary, retryBrowserStorage, exportStorageRecoveryData } = useSyncContext();
	const [busy, setBusy] = useState(false);
	const blocked = browserStorageError !== null || (!!accountId && ["degraded", "memory-only"].includes(syncStateSummary.storageState));
	if (!blocked) return null;
	const download = async () => {
		const payload = await exportStorageRecoveryData();
		const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url; link.download = "todoflare-unsaved-recovery.json";
		link.click(); URL.revokeObjectURL(url);
	};
	const retry = async () => {
		setBusy(true);
		try { await retryBrowserStorage(); }
		catch { /* The context retains the failure and the recovery copy. */ }
		finally { setBusy(false); }
	};
	return <div role="alert" className="relative z-50 flex flex-wrap items-center gap-3 bg-destructive/10 px-4 py-3 text-sm">
		<p>Editing paused because changes could not be saved. Keep this page open and download a recovery copy.</p>
		<Button size="sm" variant="outline" onClick={() => void download()}>Download recovery copy</Button>
		<Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>Retry saving</Button>
	</div>;
}
