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
		authenticationStatus,
		isReconnecting,
		isLoading,
		error,
		connectionStatus,
		syncMode,
		syncStateSummary,
		yjsOutboxSummary,
		createAccount,
		loginWithPasskey,
		loginWithRecoveryCode,
		logout,
		resetSyncTelemetry,
		restoreColumn,
		exportAccountData,
		importAccountData,
		exportStorageRecoveryData,
		hasLocalData,
	} = useSyncContext();

	return {
		// Account state
		accountId,
		account,
		deletedColumns,
		isAuthenticated: authenticationStatus === "authenticated",
		authenticationStatus,
		isReconnecting,
		isLoading,
		error,

		// Connection status
		connectionStatus,
		syncMode,
		syncStateSummary,
		yjsOutboxSummary,

		// Operations
		createAccount,
		loginWithPasskey,
		loginWithRecoveryCode,
		logout,
		resetSyncTelemetry,
		restoreColumn,
		exportAccountData,
		importAccountData,
		exportStorageRecoveryData,

		// Check for existing data
		hasLocalData,
	};
}
