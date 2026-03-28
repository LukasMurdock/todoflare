import { useSyncContext } from "@/contexts/sync-context";

/**
 * Hook for account management
 *
 * This is a convenience wrapper around the SyncContext for account-related operations.
 */
export function useAccount() {
	const {
		accountId,
		account,
		deletedColumns,
		isLoading,
		error,
		connectionStatus,
		isRealtimeDegraded,
		syncMode,
		syncStateSummary,
		pendingSendDropSummary,
		yjsOutboxSummary,
		createAccount,
		loginWithAccountId,
		logout,
		resetPendingSendDropSummary,
		resetSyncTelemetry,
		restoreColumn,
		exportAccountData,
		importAccountData,
		hasLocalData,
	} = useSyncContext();

	return {
		// Account state
		accountId,
		account,
		deletedColumns,
		isAuthenticated: !!accountId && !!account,
		isLoading,
		error,

		// Connection status
		connectionStatus,
		isRealtimeDegraded,
		syncMode,
		syncStateSummary,
		pendingSendDropSummary,
		yjsOutboxSummary,

		// Operations
		createAccount,
		loginWithAccountId,
		logout,
		resetPendingSendDropSummary,
		resetSyncTelemetry,
		restoreColumn,
		exportAccountData,
		importAccountData,

		// Check for existing data
		hasLocalData,
	};
}
