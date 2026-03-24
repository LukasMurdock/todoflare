import { useState } from "react";
import { Copy, LogOut, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccount } from "@/hooks/useAccount";
import { truncateAccountId, displayAccountId } from "@/lib/account";
import { cn } from "@/lib/utils";

export function AccountBadge() {
	const { accountId, connectionStatus, logout, isAuthenticated } = useAccount();
	const [copied, setCopied] = useState(false);

	if (!isAuthenticated || !accountId) {
		return null;
	}

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(displayAccountId(accountId));
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	};

	const statusColor = {
		connected: "bg-green-500",
		connecting: "bg-yellow-500",
		offline: "bg-red-500",
	}[connectionStatus];

	const statusText = {
		connected: "Connected",
		connecting: "Connecting...",
		offline: "Offline",
	}[connectionStatus];

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-2 px-2 font-mono text-xs"
						>
							<span
								className={cn(
									"size-2 rounded-full",
									statusColor,
									connectionStatus === "connecting" && "animate-pulse",
								)}
							/>
							<span className="hidden sm:inline">
								{truncateAccountId(accountId)}
							</span>
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>
					<p className="font-mono">{displayAccountId(accountId)}</p>
					<p className="text-muted-foreground">{statusText}</p>
				</TooltipContent>
			</Tooltip>

			<DropdownMenuContent align="end" className="w-56">
				<div className="px-2 py-1.5">
					<p className="text-xs text-muted-foreground">Account ID</p>
					<p className="font-mono text-sm">{displayAccountId(accountId)}</p>
				</div>

				<DropdownMenuSeparator />

				<DropdownMenuItem onClick={handleCopy}>
					{copied ? (
						<Check className="mr-2 h-4 w-4 text-green-500" />
					) : (
						<Copy className="mr-2 h-4 w-4" />
					)}
					{copied ? "Copied!" : "Copy Account ID"}
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuItem onClick={logout} className="text-destructive">
					<LogOut className="mr-2 h-4 w-4" />
					Log Out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
