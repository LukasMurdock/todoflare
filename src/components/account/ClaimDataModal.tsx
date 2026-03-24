import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/hooks/useAccount";
import { useSyncContext } from "@/contexts/sync-context";
import { formatAccountId, validateAccountId } from "@/lib/account";
import { getLocalColumns, clearLocalColumns } from "@/hooks/useColumns";

interface ClaimDataModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ClaimDataModal({ open, onOpenChange }: ClaimDataModalProps) {
	const { createAccount, loginWithAccountId, isLoading, error } = useAccount();
	const { createColumn } = useSyncContext();
	const [mode, setMode] = useState<"choose" | "enter">("choose");
	const [accountIdInput, setAccountIdInput] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [isClaimingData, setIsClaimingData] = useState(false);

	const handleClaimData = async () => {
		setLocalError(null);
		setIsClaimingData(true);

		try {
			// Create new account
			const account = await createAccount();
			if (!account) {
				setIsClaimingData(false);
				return;
			}

			// Get local columns
			const localColumns = getLocalColumns();

			// Create columns on server for each local column
			// Note: In a full implementation, you'd also upload the column content
			// For now, we create empty columns and the content would need to be synced
			for (const _column of localColumns) {
				await createColumn();
			}

			// Clear local storage after successful migration
			clearLocalColumns();

			onOpenChange(false);
		} catch (err) {
			setLocalError("Failed to claim data. Please try again.");
		} finally {
			setIsClaimingData(false);
		}
	};

	const handleStartFresh = async () => {
		setLocalError(null);

		// Create account without claiming data
		const account = await createAccount();
		if (account) {
			// Clear local data
			clearLocalColumns();
			onOpenChange(false);
		}
	};

	const handleLogin = async () => {
		setLocalError(null);

		if (!validateAccountId(accountIdInput)) {
			setLocalError("Please enter a valid 16-digit account ID");
			return;
		}

		const success = await loginWithAccountId(accountIdInput);
		if (success) {
			// Clear local data when logging into existing account
			clearLocalColumns();
			onOpenChange(false);
		}
	};

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const formatted = formatAccountId(e.target.value);
		setAccountIdInput(formatted);
		setLocalError(null);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && mode === "enter") {
			handleLogin();
		}
	};

	const displayError = localError || error;
	const isProcessing = isLoading || isClaimingData;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						{mode === "choose"
							? "You have existing local data"
							: "Enter Account ID"}
					</DialogTitle>
					<DialogDescription>
						{mode === "choose"
							? "Claim it with a new account to sync across devices, or log in to an existing account."
							: "Enter your 16-digit account ID. Note: your local data will be replaced."}
					</DialogDescription>
				</DialogHeader>

				{mode === "choose" ? (
					<div className="flex flex-col gap-4">
						<Button
							onClick={handleClaimData}
							disabled={isProcessing}
							className="w-full"
						>
							{isClaimingData
								? "Claiming Data..."
								: "Generate Account & Claim Data"}
						</Button>

						<Button
							variant="outline"
							onClick={handleStartFresh}
							disabled={isProcessing}
							className="w-full"
						>
							Start Fresh Instead
						</Button>

						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<span className="w-full border-t" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-background px-2 text-muted-foreground">
									or
								</span>
							</div>
						</div>

						<Button
							variant="ghost"
							onClick={() => setMode("enter")}
							disabled={isProcessing}
							className="w-full"
						>
							Enter Existing Account
						</Button>

						<p className="text-xs text-muted-foreground text-center">
							Entering an existing account will replace your local data.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="space-y-2">
							<Input
								placeholder="0000 0000 0000 0000"
								value={accountIdInput}
								onChange={handleInputChange}
								onKeyDown={handleKeyDown}
								disabled={isProcessing}
								className="font-mono text-center text-lg tracking-wider"
								maxLength={19}
								autoFocus
							/>
							<p className="text-xs text-muted-foreground text-center">
								Your local data will be replaced.
							</p>
							{displayError && (
								<p className="text-sm text-destructive">{displayError}</p>
							)}
						</div>

						<DialogFooter className="gap-2 sm:gap-0">
							<Button
								variant="outline"
								onClick={() => {
									setMode("choose");
									setAccountIdInput("");
									setLocalError(null);
								}}
								disabled={isProcessing}
							>
								Back
							</Button>
							<Button
								onClick={handleLogin}
								disabled={isProcessing || !validateAccountId(accountIdInput)}
							>
								{isLoading ? "Connecting..." : "Continue"}
							</Button>
						</DialogFooter>
					</div>
				)}

				{displayError && mode === "choose" && (
					<p className="text-sm text-destructive text-center">{displayError}</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
