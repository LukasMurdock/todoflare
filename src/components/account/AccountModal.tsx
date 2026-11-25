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
import { ChevronDown, Fingerprint, Lock } from "lucide-react";
import { useAccount } from "@/hooks/useAccount";
import { formatAccountId } from "@/lib/account";
import { cn } from "@/lib/utils";
import { AppIconTile, RecoveryCodeCard } from "./CredentialManager";

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
			if (await createAccount()) {onOpenChange(false);}
		} finally {
			setOperation(null);
		}
	};

	const recover = async () => {
		setOperation("signin");
		try {
			const rotated = await loginWithRecoveryCode(accountId, recoveryCode.trim());
			if (rotated) {setNextRecoveryCode(rotated);}
		} finally {
			setOperation(null);
		}
	};

	const signIn = async () => {
		setOperation("signin");
		try {
			if (await loginWithPasskey()) {onOpenChange(false);}
		} finally {
			setOperation(null);
		}
	};

	const busy = isLoading || operation !== null;
	useEffect(() => {
		if (!open || typeof PublicKeyCredential === "undefined") {return;}
		if (!PublicKeyCredential.isConditionalMediationAvailable) {return;}
		void PublicKeyCredential.isConditionalMediationAvailable().then((available) => {
			if (!available) {return;}
			void loginWithPasskey(true).then((success) => {
				if (success) {onOpenChange(false);}
			});
		});
	}, [loginWithPasskey, onOpenChange, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className="gap-5 sm:max-w-[26rem]">
				<DialogHeader className="items-start gap-3 text-left">
					<AppIconTile />
					<div className="space-y-1">
						<DialogTitle>Sync with a passkey</DialogTitle>
						<DialogDescription>
							Keep your columns on every device, protected by a passkey instead of a password.
						</DialogDescription>
					</div>
				</DialogHeader>
				<div className="flex flex-col gap-2.5">
					<input
						className="sr-only"
						autoComplete="username webauthn"
						aria-label="Passkey account"
					/>
					<Button onClick={() => void create()} disabled={busy} className="h-10 w-full">
						<Fingerprint className="stroke-[1.75]" />
						{operation === "create" ? "Creating passkey..." : "Create synced account"}
					</Button>
					<Button variant="outline" onClick={() => void signIn()} disabled={busy} className="h-10 w-full">
						{operation === "signin" ? "Signing in..." : "Sign in with a passkey"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={showRecovery}
						onClick={() => setShowRecovery((value) => !value)}
						disabled={busy}
						className="mx-auto gap-1 text-muted-foreground hover:text-foreground"
					>
						Use a recovery code
						<ChevronDown className={cn("size-3.5 transition-transform duration-200", showRecovery && "rotate-180")} />
					</Button>
					{showRecovery && !nextRecoveryCode && (
						<div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-3">
							<Input
								aria-label="Account ID"
								value={accountId}
								onChange={(event) => setAccountId(formatAccountId(event.target.value))}
								placeholder="0000 0000 0000 0000"
								inputMode="numeric"
								className="bg-background font-mono tracking-[0.08em] tabular-nums"
							/>
							<Input
								aria-label="Recovery code"
								value={recoveryCode}
								onChange={(event) => setRecoveryCode(event.target.value)}
								placeholder="Recovery code"
								autoComplete="off"
								spellCheck={false}
								className="bg-background font-mono text-[13px]"
							/>
							<Button className="w-full" onClick={() => void recover()} disabled={busy || accountId.replaceAll(/\D/g, "").length !== 16 || recoveryCode.length < 40}>Recover account</Button>
						</div>
					)}
					{nextRecoveryCode && (
						<div className="flex flex-col gap-2">
							<RecoveryCodeCard code={nextRecoveryCode} message="Your recovery code was rotated. Save the new code now." />
							<Button className="w-full" onClick={() => onOpenChange(false)}>I saved it</Button>
						</div>
					)}
					{error && <p className="text-center text-[13px] text-red-600 dark:text-red-400">{error}</p>}
				</div>
				<p className="flex items-start gap-2 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
					<Lock className="mt-0.5 size-3.5 shrink-0" />
					Passkeys protect your synced data. Your Account ID is only a public sharing identity and cannot sign in.
				</p>
			</DialogContent>
		</Dialog>
	);
}
