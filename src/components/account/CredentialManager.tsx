import { useCallback, useEffect, useState } from "react";
import {
	authClient,
	authFailure,
	generateRecoveryCode,
	reauthenticate,
	RecentAuthenticationRequiredError,
} from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { accountRequestHeaders } from "@/lib/account-request-headers";

interface CredentialManagerProps {
	accountId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface ListedPasskey {
	id: string;
	name?: string | null;
	createdAt?: Date | string | null;
}

export function CredentialManager({ accountId, open, onOpenChange }: CredentialManagerProps) {
	const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
	const [name, setName] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The change the server refused for want of a recent sign-in, and the
	// account it was for; it is retried once the user confirms with a passkey.
	const [pending, setPending] = useState<{ accountId: string; fallback: string; action: () => Promise<void> } | null>(null);
	// Every change names the account shown here, so the server refuses it if
	// another tab has since signed in as someone else.
	const headers = accountId ? accountRequestHeaders(accountId) : {};

	const refresh = useCallback(async () => {
		const result = await authClient.passkey.listUserPasskeys();
		if (result.error) setError(result.error.message ?? "Unable to load passkeys");
		else setPasskeys((result.data ?? []) as ListedPasskey[]);
	}, []);

	useEffect(() => {
		if (open) void refresh();
	}, [open, refresh]);

	// A pending change belongs to one opening of the dialog for one account.
	useEffect(() => {
		setPending(null);
	}, [open, accountId]);

	const run = async (fallback: string, action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await action();
			setPending(null);
		} catch (cause) {
			if (cause instanceof RecentAuthenticationRequiredError && accountId) setPending({ accountId, fallback, action });
			else setError(cause instanceof Error && cause.message ? cause.message : fallback);
		} finally {
			setBusy(false);
		}
	};

	const add = () => run("Passkey registration failed", async () => {
		const result = await authClient.passkey.addPasskey({
			name: name.trim() || `Passkey ${passkeys.length + 1}`,
			fetchOptions: { headers },
		});
		if (result.error) throw authFailure(result.error);
		setName("");
		await refresh();
	});

	const remove = (id: string) => run("Passkey removal failed", async () => {
		const result = await authClient.passkey.deletePasskey({ id, fetchOptions: { headers } });
		if (result.error) throw authFailure(result.error);
		await refresh();
		setNotice("Passkey removed. If a device was lost, also sign out other sessions.");
	});

	const createRecoveryCode = () => run("Recovery code creation failed", async () => {
		setRecoveryCode(await generateRecoveryCode(headers));
	});

	const signOutOtherSessions = () => run("Unable to sign out other sessions", async () => {
		const result = await authClient.revokeOtherSessions({ fetchOptions: { headers } });
		if (result.error) throw authFailure(result.error);
		setNotice("Other sessions are signed out.");
	});

	const confirmAndRetry = () => {
		if (!pending) return;
		const { accountId: expected, fallback, action } = pending;
		return run(fallback, async () => {
			await reauthenticate(expected);
			await action();
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Passkeys and recovery</DialogTitle>
					<DialogDescription>
						Keep at least two passkeys, or store a recovery code somewhere safe.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					{passkeys.map((passkey) => (
						<div key={passkey.id} className="flex items-center justify-between gap-3 rounded border p-2">
							<span className="text-sm">{passkey.name || "Passkey"}</span>
							<Button variant="outline" size="sm" disabled={busy} onClick={() => remove(passkey.id)}>
								Remove
							</Button>
						</div>
					))}
					<div className="flex gap-2">
						<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Passkey name" />
						<Button disabled={busy} onClick={add}>Add passkey</Button>
					</div>
					<Button variant="outline" disabled={busy} onClick={createRecoveryCode}>
						Create or rotate recovery code
					</Button>
					<Button variant="outline" disabled={busy} onClick={signOutOtherSessions}>
						Sign out other sessions
					</Button>
					{pending && (
						<div className="space-y-2 rounded border p-3">
							<p className="text-sm">Confirm it's you with a passkey to make this change.</p>
							<Button className="w-full" disabled={busy} onClick={confirmAndRetry}>
								Confirm with passkey
							</Button>
						</div>
					)}
					{recoveryCode && (
						<div className="rounded border border-amber-500/50 bg-amber-500/10 p-3">
							<p className="text-xs">Save this now. It is shown only once.</p>
							<code className="break-all text-xs">{recoveryCode}</code>
						</div>
					)}
					{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
