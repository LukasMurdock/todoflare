import { useCallback, useEffect, useRef, useState } from "react";
import { accountCredentials, RecentAuthenticationRequiredError } from "@/lib/auth-client";

interface PendingChange {
	accountId: string;
	change: () => Promise<void>;
	fallback: string;
}

/**
 * Runs credential changes that the server may refuse until the account signs
 * in again (`recent_authentication_required`, decision 0017). A refused
 * change is kept rather than thrown; `confirm`, called from a click (Safari
 * allows a passkey prompt only from one), asks for this account's passkey and
 * retries it. The kept change is dropped on cancel, an account change or
 * unmount, including while its confirmation is still in flight.
 */
export function useRecentSignIn(accountId: string | null) {
	const [pending, setPending] = useState<PendingChange | null>(null);
	// Bumped by cancel, an account change and unmount, so an attempt or a
	// confirmation still in flight cannot keep or retry an abandoned change.
	const generation = useRef(0);

	const cancel = useCallback(() => {
		generation.current++;
		setPending(null);
	}, []);

	// Runs when the account changes and on unmount.
	useEffect(() => cancel, [accountId, cancel]);

	/** Runs `change`. Other failures throw; `fallback` describes one without a message. */
	const attempt = useCallback(async (change: () => Promise<void>, fallback: string) => {
		const current = generation.current;
		try {
			await change();
			if (current === generation.current) setPending(null);
		} catch (cause) {
			if (cause instanceof RecentAuthenticationRequiredError && accountId) {
				if (current === generation.current) setPending({ accountId, change, fallback });
				return;
			}
			throw cause;
		}
	}, [accountId]);

	const confirm = useCallback(async () => {
		if (!pending) return;
		const current = generation.current;
		await accountCredentials(pending.accountId).reauthenticate();
		if (current !== generation.current) return;
		await attempt(pending.change, pending.fallback);
	}, [attempt, pending]);

	return { attempt, confirm, cancel, pending: pending !== null, fallback: pending?.fallback ?? null };
}
