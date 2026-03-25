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
		isLoading,
		error,
		connectionStatus,
		createAccount,
		loginWithAccountId,
		logout,
		exportAccountData,
		importAccountData,
		hasLocalData,
	} = useSyncContext();

	return {
		// Account state
		accountId,
		account,
		isAuthenticated: !!accountId && !!account,
		isLoading,
		error,

		// Connection status
		connectionStatus,

		// Operations
		createAccount,
		loginWithAccountId,
		logout,
		exportAccountData,
		importAccountData,

		// Check for existing data
		hasLocalData,
	};
}
