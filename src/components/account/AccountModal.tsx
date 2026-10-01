import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/hooks/useAccount";
import { formatAccountId } from "@/lib/account";

interface AccountModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AccountModal({ open, onOpenChange }: AccountModalProps) {
	const { createAccount, loginWithPasskey, loginWithRecoveryCode, isLoading, error } = useAccount();
	const [operation, setOperation] = useState<"create" | "signin" | null>(null);
	const [showRecovery, setShowRecovery] = useState(false);
	const [accountId, setAccountId] = useState("");
	const [recoveryCode, setRecoveryCode] = useState("");
	const [nextRecoveryCode, setNextRecoveryCode] = useState<string | null>(null);

	const create = async () => {
		setOperation("create");
		try {
			if (await createAccount()) onOpenChange(false);
		} finally {
			setOperation(null);
		}
	};

	const recover = async () => {
		setOperation("signin");
		try {
			const rotated = await loginWithRecoveryCode(accountId, recoveryCode.trim());
			if (rotated) setNextRecoveryCode(rotated);
		} finally {
			setOperation(null);
		}
	};

	const signIn = async () => {
		setOperation("signin");
		try {
			if (await loginWithPasskey()) onOpenChange(false);
		} finally {
			setOperation(null);
		}
	};

	const busy = isLoading || operation !== null;
	useEffect(() => {
		if (!open || typeof PublicKeyCredential === "undefined") return;
		const conditional = PublicKeyCredential.isConditionalMediationAvailable;
		if (!conditional) return;
		void conditional.call(PublicKeyCredential).then((available) => {
			if (!available) return;
			void loginWithPasskey(true).then((success) => {
				if (success) onOpenChange(false);
			});
		});
	}, [loginWithPasskey, onOpenChange, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Sync with a passkey</DialogTitle>
					<DialogDescription>
						Passkeys protect your synced data. Your Account ID is only a public
						sharing identity and cannot sign in.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<input
						className="sr-only"
						autoComplete="username webauthn"
						aria-label="Passkey account"
					/>
					<Button onClick={create} disabled={busy} className="w-full">
						{operation === "create" ? "Creating passkey..." : "Create synced account"}
					</Button>
					<Button variant="outline" onClick={signIn} disabled={busy} className="w-full">
						{operation === "signin" ? "Signing in..." : "Sign in with a passkey"}
					</Button>
					<Button variant="ghost" onClick={() => setShowRecovery((value) => !value)} disabled={busy}>
						Use a recovery code
					</Button>
					{showRecovery && !nextRecoveryCode && (
						<div className="space-y-2">
							<Input aria-label="Account ID" value={accountId} onChange={(event) => setAccountId(formatAccountId(event.target.value))} placeholder="0000 0000 0000 0000" />
							<Input aria-label="Recovery code" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder="Recovery code" />
							<Button className="w-full" onClick={recover} disabled={busy || accountId.replace(/\D/g, "").length !== 16 || recoveryCode.length < 40}>Recover account</Button>
						</div>
					)}
					{nextRecoveryCode && (
						<div className="space-y-2 rounded border border-amber-500/50 bg-amber-500/10 p-3">
							<p className="text-xs">Your recovery code was rotated. Save the new code now.</p>
							<code className="block break-all text-xs">{nextRecoveryCode}</code>
							<Button className="w-full" onClick={() => onOpenChange(false)}>I saved it</Button>
						</div>
					)}
					{error && <p className="text-sm text-destructive text-center">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
