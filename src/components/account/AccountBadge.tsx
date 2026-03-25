import { useRef, useState, type ChangeEvent } from "react";
import { Copy, LogOut, Check, Download, Upload } from "lucide-react";
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
	const {
		accountId,
		connectionStatus,
		logout,
		isAuthenticated,
		exportAccountData,
		importAccountData,
	} = useAccount();
	const [copied, setCopied] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

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

	const handleExport = async () => {
		const payload = await exportAccountData();
		if (!payload) return;

		const blob = new Blob([JSON.stringify(payload, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		link.href = url;
		link.download = `todoflare-export-${timestamp}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	const handleImportSelect = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;

		try {
			const text = await file.text();
			const payload = JSON.parse(text);
			await importAccountData(payload);
		} catch (err) {
			console.error("Failed to import file:", err);
		}
	};

	return (
		<DropdownMenu>
			<input
				ref={fileInputRef}
				type="file"
				accept="application/json"
				onChange={handleImportSelect}
				className="hidden"
			/>
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

				<DropdownMenuItem onClick={handleExport}>
					<Download className="mr-2 h-4 w-4" />
					Export Data
				</DropdownMenuItem>

				<DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
					<Upload className="mr-2 h-4 w-4" />
					Import Data
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
