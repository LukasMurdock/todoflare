import { useCallback } from "react";
import { toast } from "sonner";
import { displayAccountId, validateAccountId } from "@/lib/account";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
} from "@/lib/sync/contracts";
import type { LocalYjsUpdateOutbox } from "@/lib/sync/yjs-update-outbox";
import type { ColumnMeta } from "@/types/account";
import type {
	AccountConvergenceActor,
	useAccountCommandSubmission,
} from "./use-account-convergence";

interface AccountColumnCommandDependencies {
	accountId: string | null;
	accountConvergenceActor: AccountConvergenceActor;
	submitAccountCommand: ReturnType<typeof useAccountCommandSubmission>["submitAccountCommand"];
	detachColumnSync(columnId: string): void;
	yjsOutbox: LocalYjsUpdateOutbox;
	refreshYjsOutboxSummary(): void;
	setError(message: string): void;
}

/**
 * UI entry points for every account command. Each one queues its command for
 * durable replay; the shared submit step reports failures the same way.
 */
export function useAccountColumnCommands({
	accountId,
	accountConvergenceActor,
	submitAccountCommand,
	detachColumnSync,
	yjsOutbox,
	refreshYjsOutboxSummary,
	setError,
}: AccountColumnCommandDependencies) {
	/** Resolves false when the command failed terminally or could not be queued. */
	const submit = useCallback(
		async <T extends AccountCommandType>(
			opType: T,
			payload: AccountCommandPayloadMap[NoInfer<T>],
		): Promise<boolean> => {
			try {
				const { outcome } = await submitAccountCommand(opType, payload);
				return outcome !== "terminal";
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[setError, submitAccountCommand],
	);

	const createColumn = useCallback(async () => {
		if (!accountId) return null;

		const columnId = crypto.randomUUID();
		const provisionalColumn: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: displayAccountId(accountId),
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		try {
			const { outcome } = await submitAccountCommand("column.create", { columnId });

			if (outcome === "terminal") {
				detachColumnSync(columnId);
				const droppedYjsCount = yjsOutbox.dropForColumn(accountId, columnId);
				refreshYjsOutboxSummary();
				toast.error(
					droppedYjsCount > 0
						? "Column could not be created. Unsynced changes were discarded."
						: "Column could not be created.",
				);
				return null;
			}

			return provisionalColumn;
		} catch (err) {
			detachColumnSync(columnId);
			setError(err instanceof Error ? err.message : "Unknown error");
			return null;
		}
	}, [
		accountId,
		detachColumnSync,
		refreshYjsOutboxSummary,
		setError,
		submitAccountCommand,
		yjsOutbox,
	]);

	const deleteColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;
			detachColumnSync(columnId);
			return submit("column.delete", { columnId });
		},
		[accountId, detachColumnSync, submit],
	);

	const restoreColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;
			return submit("column.restore", { columnId });
		},
		[accountId, submit],
	);

	const shareColumn = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId || !validateAccountId(targetAccountId)) return false;
			return submit("column.share", { columnId, targetAccountId });
		},
		[accountId, submit],
	);

	const revokeShare = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId || !validateAccountId(targetAccountId)) return false;
			return submit("column.revoke", { columnId, targetAccountId });
		},
		[accountId, submit],
	);

	const enablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return null;
			if (!(await submit("column.public.enable", { columnId }))) return null;
			return (
				accountConvergenceActor.getSnapshot().context.projection
					?.publicLinksByColumn[columnId] ?? null
			);
		},
		[accountConvergenceActor, accountId, submit],
	);

	const disablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;
			return submit("column.public.disable", { columnId });
		},
		[accountId, submit],
	);

	// Reorder and hide are background preferences: failures are logged, not surfaced.
	const updateColumnOrder = useCallback(
		async (columnOrder: string[]) => {
			if (!accountId) return;
			try {
				await submitAccountCommand("column.reorder", { columnOrder });
			} catch (err) {
				console.error("Failed to update column order:", err);
			}
		},
		[accountId, submitAccountCommand],
	);

	const updateHiddenSharedColumns = useCallback(
		async (hiddenSharedColumns: string[]) => {
			if (!accountId) return;
			try {
				await submitAccountCommand("column.hide_shared", { hiddenSharedColumns });
			} catch (err) {
				console.error("Failed to update hidden shared columns:", err);
			}
		},
		[accountId, submitAccountCommand],
	);

	return {
		createColumn,
		deleteColumn,
		restoreColumn,
		shareColumn,
		revokeShare,
		enablePublicLink,
		disablePublicLink,
		updateColumnOrder,
		updateHiddenSharedColumns,
	};
}
