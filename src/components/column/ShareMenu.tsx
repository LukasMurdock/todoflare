import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Share2, Copy, Check, RefreshCw, X, Link, Unlink } from "lucide-react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSyncContext } from "@/contexts/sync-context";
import {
	formatAccountId,
	validateAccountId,
	truncateAccountId,
} from "@/lib/account";
import type { ColumnMeta } from "@/types/account";

interface ShareMenuProps {
	columnId: string;
	columnMeta?: ColumnMeta;
}

export function ShareMenu({ columnId, columnMeta }: ShareMenuProps) {
	const { shareColumn, revokeShare, enablePublicLink, disablePublicLink } =
		useSyncContext();

	const [isOpen, setIsOpen] = useState(false);
	const [shareInput, setShareInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSharing, setIsSharing] = useState(false);
	const [isTogglingPublic, setIsTogglingPublic] = useState(false);
	const [copied, setCopied] = useState(false);
	const [publicLinkCopied, setPublicLinkCopied] = useState(false);

	// Local state for optimistic updates
	const [localSharedWith, setLocalSharedWith] = useState<string[]>([]);
	const [localPublicId, setLocalPublicId] = useState<string | null>(null);
	const [publicUrl, setPublicUrl] = useState<string | null>(null);

	// Sync with props
	useEffect(() => {
		if (columnMeta) {
			setLocalSharedWith((prev) => {
				const incoming = columnMeta.sharedWith || [];
				if (incoming.length === 0 && prev.length > 0) {
					return prev;
				}
				return incoming;
			});
			setLocalPublicId(columnMeta.publicId || null);
			if (columnMeta.publicId) {
				setPublicUrl(`${window.location.origin}/p/${columnMeta.publicId}`);
			} else {
				setPublicUrl(null);
			}
		}
	}, [columnMeta]);

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const formatted = formatAccountId(e.target.value);
		setShareInput(formatted);
		setError(null);
	};

	const handleShare = async () => {
		if (!validateAccountId(shareInput)) {
			setError("Please enter a valid 16-digit account ID");
			return;
		}

		setIsSharing(true);
		setError(null);

		const success = await shareColumn(columnId, shareInput);

		if (success) {
			setLocalSharedWith((prev) => [...prev, shareInput]);
			setShareInput("");
			toast.success("Column shared successfully!");
		} else {
			setError("Failed to share. Check the account ID.");
		}

		setIsSharing(false);
	};

	const handleRevoke = async (accountId: string) => {
		const success = await revokeShare(columnId, accountId);
		if (success) {
			setLocalSharedWith((prev) =>
				prev.filter(
					(id) => id.replace(/\s/g, "") !== accountId.replace(/\s/g, ""),
				),
			);
			toast.success("Access revoked");
		}
	};

	const handleEnablePublicLink = async () => {
		setIsTogglingPublic(true);
		const result = await enablePublicLink(columnId);
		if (result) {
			setLocalPublicId(result.publicId);
			setPublicUrl(result.url);
			toast.success("Public link enabled!");
		}
		setIsTogglingPublic(false);
	};

	const handleDisablePublicLink = async () => {
		setIsTogglingPublic(true);
		const success = await disablePublicLink(columnId);
		if (success) {
			setLocalPublicId(null);
			toast.success("Public link disabled");
			setPublicUrl(null);
		}
		setIsTogglingPublic(false);
	};

	const handleCopyPublicLink = async () => {
		if (!publicUrl) return;
		try {
			await navigator.clipboard.writeText(publicUrl);
			setPublicLinkCopied(true);
			setTimeout(() => setPublicLinkCopied(false), 2000);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleShare();
		}
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				<button
					className="rounded p-1 hover:bg-muted"
					type="button"
					aria-label="Share column"
					title="Share column"
				>
					<Share2 className="h-4 w-4 text-muted-foreground" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80">
				<div className="space-y-4">
					<div className="space-y-2">
						<h4 className="font-medium text-sm">Share with account</h4>
						<div className="flex gap-2">
							<Input
								aria-label="Account ID"
								placeholder="0000 0000 0000 0000"
								value={shareInput}
								onChange={handleInputChange}
								onKeyDown={handleKeyDown}
								disabled={isSharing}
								className="font-mono text-sm"
								maxLength={19}
							/>
							<Button
								size="sm"
								onClick={handleShare}
								disabled={isSharing || !validateAccountId(shareInput)}
							>
								{isSharing ? "..." : "Share"}
							</Button>
						</div>
						{error && <p className="text-xs text-destructive">{error}</p>}
					</div>

					{localSharedWith.length > 0 && (
						<div className="space-y-2">
							<h4 className="font-medium text-sm text-muted-foreground">
								Shared with
							</h4>
							<div className="space-y-1">
								{localSharedWith.map((accountId) => (
									<div
										key={accountId}
										className="flex items-center justify-between py-1"
									>
										<span className="font-mono text-sm">
											{truncateAccountId(accountId)}
										</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => handleRevoke(accountId)}
										aria-label={`Revoke access for ${truncateAccountId(accountId)}`}
										className="h-6 px-2 text-destructive hover:text-destructive"
									>
											<X className="h-3 w-3" />
										</Button>
									</div>
								))}
							</div>
						</div>
					)}

					<div className="border-t pt-4 space-y-2">
						<h4 className="font-medium text-sm">Public link</h4>
						{localPublicId ? (
							<div className="space-y-2">
								<div className="flex items-center gap-2">
									<span className="flex-1 text-xs font-mono bg-muted px-2 py-1 rounded truncate">
										{publicUrl}
									</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={handleCopyPublicLink}
										className="h-7 px-2"
									>
										{publicLinkCopied ? (
											<Check className="h-3 w-3 text-green-500" />
										) : (
											<Copy className="h-3 w-3" />
										)}
									</Button>
								</div>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={handleEnablePublicLink}
										disabled={isTogglingPublic}
										className="flex-1"
									>
										<RefreshCw className="h-3 w-3 mr-1" />
										Regenerate
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={handleDisablePublicLink}
										disabled={isTogglingPublic}
										className="flex-1 text-destructive hover:text-destructive"
									>
										<Unlink className="h-3 w-3 mr-1" />
										Disable
									</Button>
								</div>
							</div>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={handleEnablePublicLink}
								disabled={isTogglingPublic}
								className="w-full"
							>
								<Link className="h-3 w-3 mr-1" />
								{isTogglingPublic ? "Enabling..." : "Enable public link"}
							</Button>
						)}
						<p className="text-xs text-muted-foreground">
							Anyone with the link can view (read-only)
						</p>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
