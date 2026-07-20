import { normalizeAccountId } from "../account";

export interface AccountHydrationGuard {
	accountId: string;
	projectionRevision: number;
	requestGeneration: number;
}

/**
 * Server hydration is a snapshot, not an event stream. Only apply it while it
 * still describes the active account and no newer local command has changed
 * the optimistic projection since the request began.
 */
export function canApplyAccountHydration(
	guard: AccountHydrationGuard,
	current: AccountHydrationGuard,
): boolean {
	return (
		normalizeAccountId(guard.accountId) ===
			normalizeAccountId(current.accountId) &&
		guard.projectionRevision === current.projectionRevision &&
		guard.requestGeneration === current.requestGeneration
	);
}
