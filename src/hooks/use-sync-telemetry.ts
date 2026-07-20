import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { LocalFirstDatabase } from "../lib/local-first/database";
import { summarizeReplayReport } from "../lib/sync/account-command-reconciliation";
import type { ReplayReport } from "../lib/sync/contracts";
import type { SyncMode } from "../lib/sync/mode-machine";
import { normalizeAccountId } from "../lib/account";

export interface SyncStateSummary {
	queueDepth: number;
	yjsQueueDepth: number;
	lastServerHydrationAt: number | null;
	lastReplayAt: number | null;
	lastReplayLatencyMs: number | null;
	revokeDiscardCount: number;
	convergenceFailureCount: number;
}

function syncStateDocId(accountId: string | null): string {
	return accountId ? `sync:${normalizeAccountId(accountId)}` : "sync:anonymous";
}

export function useSyncTelemetry(params: {
	accountId: string | null;
	mode: SyncMode;
	queueDepth: number;
	yjsQueueDepth: number;
	convergedAt: number | null;
	replayAt: number | null;
	replayDurationMs: number | null;
	replayReport: ReplayReport | null;
	ensureLocalFirstDb: () => Promise<LocalFirstDatabase>;
}) {
	const {
		accountId,
		mode,
		queueDepth,
		yjsQueueDepth,
		convergedAt,
		replayAt,
		replayDurationMs,
		replayReport,
		ensureLocalFirstDb,
	} = params;
	const [lastServerHydrationAt, setLastServerHydrationAt] = useState<
		number | null
	>(null);
	const [lastReplayAt, setLastReplayAt] = useState<number | null>(null);
	const [lastReplayLatencyMs, setLastReplayLatencyMs] = useState<number | null>(
		null,
	);
	const [revokeDiscardCount, setRevokeDiscardCount] = useState(0);
	const [convergenceFailureCount, setConvergenceFailureCount] = useState(0);
	const [hydratedDocId, setHydratedDocId] = useState<string | null>(null);
	const handledReplayReportRef = useRef<ReplayReport | null>(null);
	const activeDocId = syncStateDocId(accountId);

	useEffect(() => {
		let cancelled = false;
		setHydratedDocId(null);
		setLastServerHydrationAt(null);
		setLastReplayAt(null);
		setLastReplayLatencyMs(null);
		setRevokeDiscardCount(0);
		setConvergenceFailureCount(0);

		void ensureLocalFirstDb()
			.then((db) => {
				if (cancelled) return;
				const snapshot = db.collections.syncState.get(activeDocId);
				setLastServerHydrationAt((current) => {
					const loaded = snapshot?.lastServerHydrationAt ?? null;
					if (loaded === null) return current;
					return current === null ? loaded : Math.max(current, loaded);
				});
				setLastReplayAt((current) => {
					const loaded = snapshot?.lastReplayAt ?? null;
					if (loaded === null) return current;
					return current === null ? loaded : Math.max(current, loaded);
				});
				setLastReplayLatencyMs((current) =>
					current ?? snapshot?.lastReplayLatencyMs ?? null,
				);
				setRevokeDiscardCount((current) =>
					Math.max(current, snapshot?.revokeDiscardCount ?? 0),
				);
				setConvergenceFailureCount((current) =>
					Math.max(current, snapshot?.convergenceFailureCount ?? 0),
				);
				setHydratedDocId(activeDocId);
			})
			.catch((error: unknown) => {
				console.error("Failed to load sync state from local store:", error);
				if (!cancelled) setHydratedDocId(activeDocId);
			});

		return () => {
			cancelled = true;
		};
	}, [accountId, activeDocId, ensureLocalFirstDb]);

	// Apply live actor telemetry after the account-reset effect above. A fast
	// startup replay can otherwise be written and immediately cleared in the same
	// effect flush before the local snapshot finishes loading.
	useEffect(() => {
		if (replayAt === null) return;
		setLastReplayAt((current) =>
			current === null ? replayAt : Math.max(current, replayAt),
		);
	}, [replayAt]);

	useEffect(() => {
		if (convergedAt === null) return;
		setLastServerHydrationAt((current) =>
			current === null ? convergedAt : Math.max(current, convergedAt),
		);
	}, [convergedAt]);

	useEffect(() => {
		const report = replayReport;
		if (!report || handledReplayReportRef.current === report) return;
		handledReplayReportRef.current = report;
		if (replayDurationMs !== null) {
			setLastReplayLatencyMs(replayDurationMs);
		}
		if (summarizeReplayReport(report).nonAccessLossFailureCount > 0) {
			setConvergenceFailureCount((value) => value + 1);
			toast.error("Some offline changes could not be synced");
		}
	}, [replayDurationMs, replayReport]);

	useEffect(() => {
		if (hydratedDocId !== activeDocId) return;
		void ensureLocalFirstDb()
			.then((db) => {
				db.collections.syncState.set(activeDocId, {
					id: activeDocId,
					accountId,
					mode,
					queueDepth,
					yjsQueueDepth,
					lastServerHydrationAt,
					lastReplayAt,
					lastReplayLatencyMs,
					revokeDiscardCount,
					convergenceFailureCount,
					updatedAt: Date.now(),
				});
			})
			.catch((error: unknown) => {
				console.error("Failed to persist sync state to local store:", error);
			});
	}, [
		activeDocId,
		convergenceFailureCount,
		hydratedDocId,
		lastReplayAt,
		lastReplayLatencyMs,
		lastServerHydrationAt,
		accountId,
		ensureLocalFirstDb,
		mode,
		queueDepth,
		yjsQueueDepth,
		revokeDiscardCount,
	]);

	const recordRevokeDiscard = useCallback((count: number) => {
		if (count > 0) setRevokeDiscardCount((current) => current + count);
	}, []);

	const resetSyncTelemetry = useCallback(() => {
		setLastReplayLatencyMs(null);
		setRevokeDiscardCount(0);
		setConvergenceFailureCount(0);
	}, []);

	const summary = useMemo<SyncStateSummary>(
		() => ({
			queueDepth,
			yjsQueueDepth,
			lastServerHydrationAt,
			lastReplayAt,
			lastReplayLatencyMs,
			revokeDiscardCount,
			convergenceFailureCount,
		}),
		[
			convergenceFailureCount,
			lastReplayAt,
			lastReplayLatencyMs,
			lastServerHydrationAt,
			queueDepth,
			yjsQueueDepth,
			revokeDiscardCount,
		],
	);

	return {
		summary,
		lastServerHydrationAt,
		recordRevokeDiscard,
		resetSyncTelemetry,
	};
}
