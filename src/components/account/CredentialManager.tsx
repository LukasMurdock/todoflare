import { useCallback, useEffect, useMemo, useState } from "react";
import {
	accountCredentials,
	RecentAuthenticationRequiredError,
	type AccountCredentials,
	type ListedPasskey,
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

interface CredentialManagerProps {
	accountId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type CredentialChange = (credentials: AccountCredentials) => Promise<void>;

export function CredentialManager({ accountId, open, onOpenChange }: CredentialManagerProps) {
	const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
	const [name, setName] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const credentials = useMemo(() => (accountId ? accountCredentials(accountId) : null), [accountId]);
	// The change the server refused for want of a recent sign-in, with the
	// account it was for; it is retried once the user confirms with a passkey.
	const [pending, setPending] = useState<{ credentials: AccountCredentials; fallback: string; change: CredentialChange } | null>(null);

	const refresh = useCallback(async (on: AccountCredentials) => {
		try {
			setPasskeys(await on.listPasskeys());
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Unable to load passkeys");
		}
	}, []);

	useEffect(() => {
		if (open && credentials) void refresh(credentials);
	}, [open, credentials, refresh]);

	// A pending change belongs to one opening of the dialog for one account.
	useEffect(() => {
		setPending(null);
	}, [open, credentials]);

	const run = async (
		fallback: string,
		change: CredentialChange,
		{ on = credentials, confirmFirst = false }: { on?: AccountCredentials | null; confirmFirst?: boolean } = {},
	) => {
		if (!on) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			if (confirmFirst) await on.reauthenticate();
			await change(on);
			setPending(null);
		} catch (cause) {
			if (cause instanceof RecentAuthenticationRequiredError) setPending({ credentials: on, fallback, change });
			else setError(cause instanceof Error && cause.message ? cause.message : fallback);
		} finally {
			setBusy(false);
		}
	};

	const add = () => run("Passkey registration failed", async (on) => {
		await on.addPasskey(name.trim() || `Passkey ${passkeys.length + 1}`);
		setName("");
		await refresh(on);
	});

	const remove = (passkey: ListedPasskey) => run("Passkey removal failed", async (on) => {
		await on.deletePasskey(passkey);
		await refresh(on);
		setNotice("Passkey removed. If a device was lost, also sign out other sessions.");
	});

	const createRecoveryCode = () => run("Recovery code creation failed", async (on) => {
		setRecoveryCode(await on.generateRecoveryCode());
	});

	const signOutOtherSessions = () => run("Unable to sign out other sessions", async (on) => {
		await on.revokeOtherSessions();
		setNotice("Other sessions are signed out.");
	});

	const confirmAndRetry = () => {
		if (!pending) return;
		return run(pending.fallback, pending.change, { on: pending.credentials, confirmFirst: true });
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
							<Button variant="outline" size="sm" disabled={busy} onClick={() => remove(passkey)}>
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
