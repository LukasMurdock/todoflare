import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/hooks/useAccount";
import { clearLocalColumns } from "@/hooks/useColumns";

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
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>You have local data</DialogTitle>
					<DialogDescription>
						Create a passkey-protected account to claim it, or sign in to replace
						it with an existing synced account.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<Button onClick={() => create(false)} disabled={busy} className="w-full">
						{operation === "claim" ? "Creating passkey..." : "Create account and claim data"}
					</Button>
					<Button variant="outline" onClick={() => create(true)} disabled={busy}>
						Start fresh with a passkey
					</Button>
					<Button variant="ghost" onClick={signIn} disabled={busy}>
						{operation === "signin" ? "Signing in..." : "Sign in with a passkey"}
					</Button>
					{error && <p className="text-sm text-destructive text-center">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
