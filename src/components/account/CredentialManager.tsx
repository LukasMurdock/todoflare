import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { AUTH_BASE_PATH } from "@/lib/api/routes";

interface CredentialManagerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface ListedPasskey {
	id: string;
	name?: string | null;
	createdAt?: Date | string | null;
}

export function CredentialManager({ open, onOpenChange }: CredentialManagerProps) {
	const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
	const [name, setName] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const result = await authClient.passkey.listUserPasskeys();
		if (result.error) setError(result.error.message ?? "Unable to load passkeys");
		else setPasskeys((result.data ?? []) as ListedPasskey[]);
	}, []);

	useEffect(() => {
		if (open) void refresh();
	}, [open, refresh]);

	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await authClient.passkey.addPasskey({
				name: name.trim() || `Passkey ${passkeys.length + 1}`,
			});
			if (result.error) throw new Error(result.error.message ?? "Passkey registration failed");
			setName("");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Passkey registration failed");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		setError(null);
		try {
			const result = await authClient.passkey.deletePasskey({ id });
			if (result.error) throw new Error(result.error.message ?? "Passkey removal failed");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Passkey removal failed");
		} finally {
			setBusy(false);
		}
	};

	const createRecoveryCode = async () => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`${AUTH_BASE_PATH}/recovery-code/generate`, { method: "POST" });
			const body = (await response.json()) as { recoveryCode?: string; message?: string };
			if (!response.ok || !body.recoveryCode) throw new Error(body.message ?? "Recovery code creation failed");
			setRecoveryCode(body.recoveryCode);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Recovery code creation failed");
		} finally {
			setBusy(false);
		}
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
					{recoveryCode && (
						<div className="rounded border border-amber-500/50 bg-amber-500/10 p-3">
							<p className="text-xs">Save this now. It is shown only once.</p>
							<code className="break-all text-xs">{recoveryCode}</code>
						</div>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
