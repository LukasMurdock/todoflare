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
import { formatAccountId, validateAccountId } from "@/lib/account";

interface AccountModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AccountModal({ open, onOpenChange }: AccountModalProps) {
	const { createAccount, loginWithAccountId, isLoading, error } = useAccount();
	const [mode, setMode] = useState<"choose" | "enter">("choose");
	const [accountIdInput, setAccountIdInput] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const handleGenerateAccount = async () => {
		setLocalError(null);
		const account = await createAccount();
		if (account) {
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						{mode === "choose" ? "Welcome to Todoflare" : "Enter Account ID"}
					</DialogTitle>
					<DialogDescription>
						{mode === "choose"
							? "Generate a new account or enter an existing one to sync your data across devices."
							: "Enter your 16-digit account ID to access your data."}
					</DialogDescription>
				</DialogHeader>

				{mode === "choose" ? (
					<div className="flex flex-col gap-4">
						<Button
							onClick={handleGenerateAccount}
							disabled={isLoading}
							className="w-full"
						>
							{isLoading ? "Creating..." : "Generate New Account"}
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
							variant="outline"
							onClick={() => setMode("enter")}
							disabled={isLoading}
							className="w-full"
						>
							Enter Existing Account
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="space-y-2">
							<Input
								aria-label="Account ID"
								placeholder="0000 0000 0000 0000"
								value={accountIdInput}
								onChange={handleInputChange}
								onKeyDown={handleKeyDown}
								disabled={isLoading}
								className="font-mono text-center text-lg tracking-wider"
								maxLength={19} // 16 digits + 3 spaces
								autoFocus
							/>
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
								disabled={isLoading}
							>
								Back
							</Button>
							<Button
								onClick={handleLogin}
								disabled={isLoading || !validateAccountId(accountIdInput)}
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
