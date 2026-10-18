import { useCallback } from "react";
import { toast } from "sonner";
import { accountRequestHeaders } from "@/lib/account-request-headers";
import { API_ROUTES } from "@/lib/api/routes";
import type { AccountExportPayload } from "@/types/account";

interface AccountDataTransferDependencies {
	accountId: string | null;
	/** Re-reads the account after an import so the UI reflects it. */
	fetchAccount(accountId: string): Promise<unknown>;
	setError(message: string): void;
}

/** Account export and import through the server's export/import routes. */
export function useAccountDataTransfer({
	accountId,
	fetchAccount,
	setError,
}: AccountDataTransferDependencies) {
	const exportAccountData = useCallback(async () => {
		if (!accountId) return null;

		try {
			const response = await fetch(API_ROUTES.exportAccount.path, {
				method: API_ROUTES.exportAccount.method,
				headers: accountRequestHeaders(accountId),
			});

			if (!response.ok) {
				throw new Error("Failed to export account data");
			}

			return (await response.json()) as AccountExportPayload;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			toast.error("Failed to export data");
			return null;
		}
	}, [accountId, setError]);

	const importAccountData = useCallback(
		async (payload: AccountExportPayload) => {
			if (!accountId) return false;

			try {
				const response = await fetch(API_ROUTES.importAccount.path, {
					method: API_ROUTES.importAccount.method,
					headers: {
						...accountRequestHeaders(accountId),
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				});

				if (!response.ok) {
					throw new Error("Failed to import account data");
				}

				await fetchAccount(accountId);
				toast.success("Data imported successfully");
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				toast.error("Failed to import data");
				return false;
			}
		},
		[accountId, fetchAccount, setError],
	);

	return { exportAccountData, importAccountData };
}
