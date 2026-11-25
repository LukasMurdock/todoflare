import { useState } from "react";
import { useSyncContext } from "@/contexts/sync-context";
import { AlertTriangle, Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function StorageRecoveryBanner() {
	const { accountId, browserStorageError, syncStateSummary, retryBrowserStorage, exportStorageRecoveryData } = useSyncContext();
	const [busy, setBusy] = useState(false);
	const blocked = browserStorageError !== null || (!!accountId && ["degraded", "memory-only"].includes(syncStateSummary.storageState));
	if (!blocked) {return null;}
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
	return (
		<div
			role="alert"
			className="relative z-50 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-b border-red-500/25 bg-red-50/95 px-4 py-2.5 text-[13px] backdrop-blur-md sm:grid-cols-[auto_1fr_auto] sm:pr-32 dark:bg-red-950/80"
		>
			<span className="flex size-7 items-center justify-center self-start rounded-md bg-red-500/15 text-red-700 sm:self-center dark:text-red-300">
				<AlertTriangle className="size-4 stroke-[1.75]" />
			</span>
			<p className="min-w-0 font-medium max-sm:pr-10">Editing paused because changes could not be saved. Keep this page open and download a recovery copy.</p>
			<div className="flex gap-2 max-sm:col-span-2">
				<Button size="sm" className="max-sm:flex-1" onClick={() => void download()}>
					<Download />
					Download recovery copy
				</Button>
				<Button size="sm" variant="outline" className="max-sm:flex-1" disabled={busy} onClick={() => void retry()}>
					<RotateCcw />
					Retry saving
				</Button>
			</div>
		</div>
	);
}
