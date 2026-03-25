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
		createAccount,
		loginWithAccountId,
		logout,
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

		// Operations
		createAccount,
		loginWithAccountId,
		logout,
		restoreColumn,
		exportAccountData,
		importAccountData,

		// Check for existing data
		hasLocalData,
	};
}
