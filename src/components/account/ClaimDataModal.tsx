import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Fingerprint, Lock } from "lucide-react";
import { useAccount } from "@/hooks/useAccount";
import { clearLocalColumns } from "@/hooks/useColumns";
import { AppIconTile } from "./CredentialManager";

interface ClaimDataModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ClaimDataModal({ open, onOpenChange }: ClaimDataModalProps) {
	const { createAccount, loginWithPasskey, isLoading, error } = useAccount();
	const [operation, setOperation] = useState<"claim" | "fresh" | "signin" | null>(null);

	const create = async (startFresh: boolean) => {
		setOperation(startFresh ? "fresh" : "claim");
		try {
			if (await createAccount()) {
				if (startFresh) clearLocalColumns();
				onOpenChange(false);
			}
		} finally {
			setOperation(null);
		}
	};

	const signIn = async () => {
		setOperation("signin");
		try {
			if (await loginWithPasskey()) {
				clearLocalColumns();
				onOpenChange(false);
			}
		} finally {
			setOperation(null);
		}
	};

	const busy = isLoading || operation !== null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className="gap-5 sm:max-w-[26rem]">
				<DialogHeader className="items-start gap-3 text-left">
					<AppIconTile />
					<div className="space-y-1">
						<DialogTitle>You have local data</DialogTitle>
						<DialogDescription>
							Create a passkey-protected account to claim it, or sign in to replace
							it with an existing synced account.
						</DialogDescription>
					</div>
				</DialogHeader>
				<div className="flex flex-col gap-2.5">
					<Button onClick={() => create(false)} disabled={busy} className="h-10 w-full">
						<Fingerprint className="stroke-[1.75]" />
						{operation === "claim" ? "Creating passkey..." : "Create account and claim data"}
					</Button>
					<div className="flex flex-col gap-1">
						<Button
							variant="outline"
							onClick={() => create(true)}
							disabled={busy}
							aria-describedby="claim-fresh-caption"
							className="h-10 w-full hover:border-red-500/40"
						>
							Start fresh with a passkey
						</Button>
						<p id="claim-fresh-caption" className="text-center text-xs text-muted-foreground">
							Clears the columns in this browser.
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={signIn}
						disabled={busy}
						className="mx-auto text-muted-foreground hover:text-foreground"
					>
						{operation === "signin" ? "Signing in..." : "Sign in with a passkey"}
					</Button>
					{error && <p className="text-center text-[13px] text-red-600 dark:text-red-400">{error}</p>}
				</div>
				<p className="flex items-start gap-2 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
					<Lock className="mt-0.5 size-3.5 shrink-0" />
					Signing in to an existing account replaces the columns in this browser with that account's.
				</p>
			</DialogContent>
		</Dialog>
	);
}
