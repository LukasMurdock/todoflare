import { useState, useEffect } from "react";
import { useSyncContext } from "@/contexts/sync-context";
import type { PresenceUser, SyncMessage } from "@/types/account";

/**
 * Hook for presence awareness on a column
 *
 * Returns the list of users currently viewing/editing a column.
 * Filters out the current user.
 */
export function usePresence(columnId: string) {
	const { accountId, onColumnMessage, getColumnPresence } = useSyncContext();
	const [presence, setPresence] = useState<PresenceUser[]>([]);

	useEffect(() => {
		if (!columnId) return;

		// Get initial presence
		const initialPresence = getColumnPresence(columnId);
		setPresence(filterSelf(initialPresence, accountId));

		// Subscribe to presence updates
		const unsubscribe = onColumnMessage(columnId, (message: SyncMessage) => {
			if (message.type === "presence") {
				setPresence(filterSelf(message.users, accountId));
			}
		});

		return unsubscribe;
	}, [columnId, accountId, onColumnMessage, getColumnPresence]);

	return presence;
}

/**
 * Filter out the current user from presence list
 */
function filterSelf(
	users: PresenceUser[],
	currentAccountId: string | null,
): PresenceUser[] {
	if (!currentAccountId) return users;

	return users.filter((user) => {
		// Normalize for comparison
		const userId = user.accountId.replace(/\s/g, "");
		const currentId = currentAccountId.replace(/\s/g, "");
		return userId !== currentId;
	});
}
