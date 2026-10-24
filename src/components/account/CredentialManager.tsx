import { useCallback, useEffect, useMemo, useState } from "react";
import { accountCredentials, type AccountCredentials, type ListedPasskey } from "@/lib/auth-client";
import { useRecentSignIn } from "@/hooks/use-recent-sign-in";
import { ConfirmSignIn } from "./ConfirmSignIn";
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

export function CredentialManager({ accountId, open, onOpenChange }: CredentialManagerProps) {
	const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
	const [name, setName] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const credentials = useMemo(() => (accountId ? accountCredentials(accountId) : null), [accountId]);
	const recent = useRecentSignIn(accountId);
	const { cancel } = recent;
	// While a refused change waits for confirmation, nothing else may change.
	const locked = busy || recent.pending;

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

	// A kept change belongs to one opening of the dialog.
	useEffect(() => {
		cancel();
	}, [open, cancel]);

	const run = async (fallback: string, action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : fallback);
		} finally {
			setBusy(false);
		}
	};

	const change = (fallback: string, action: (on: AccountCredentials) => Promise<void>) => {
		if (!credentials) return;
		const on = credentials;
		return run(fallback, () => recent.attempt(() => action(on), fallback));
	};

	const add = () => change("Passkey registration failed", async (on) => {
		await on.addPasskey(name.trim() || `Passkey ${passkeys.length + 1}`);
		setName("");
		await refresh(on);
	});

	const remove = (passkey: ListedPasskey) => change("Passkey removal failed", async (on) => {
		await on.deletePasskey(passkey);
		await refresh(on);
		setNotice("Passkey removed. If a device was lost, also sign out other sessions.");
	});

	const createRecoveryCode = () => change("Recovery code creation failed", async (on) => {
		setRecoveryCode(await on.generateRecoveryCode());
	});

	const signOutOtherSessions = () => change("Unable to sign out other sessions", async (on) => {
		await on.revokeOtherSessions();
		setNotice("Other sessions are signed out.");
	});

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
							<Button variant="outline" size="sm" disabled={locked} onClick={() => remove(passkey)}>
								Remove
							</Button>
						</div>
					))}
					<div className="flex gap-2">
						<Input value={name} disabled={locked} onChange={(event) => setName(event.target.value)} placeholder="Passkey name" />
						<Button disabled={locked} onClick={add}>Add passkey</Button>
					</div>
					<Button variant="outline" disabled={locked} onClick={createRecoveryCode}>
						Create or rotate recovery code
					</Button>
					<Button variant="outline" disabled={locked} onClick={signOutOtherSessions}>
						Sign out other sessions
					</Button>
					{recent.pending && (
						<ConfirmSignIn busy={busy} onConfirm={() => run(recent.fallback ?? "Passkey confirmation failed", recent.confirm)} onCancel={recent.cancel} />
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
