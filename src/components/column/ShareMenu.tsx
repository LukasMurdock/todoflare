import { useState } from "react";
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
import { publicPageUrl } from "@/lib/api/routes";

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
	const [publicLinkCopied, setPublicLinkCopied] = useState(false);

	const sharedWith = columnMeta?.sharedWith ?? [];
	const publicId = columnMeta?.publicId ?? null;
	const publicUrl = publicId
		? publicPageUrl(window.location.origin, publicId)
		: null;

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
			toast.success("Access revoked");
		}
	};

	const handleEnablePublicLink = async () => {
		setIsTogglingPublic(true);
		const result = await enablePublicLink(columnId);
		if (result) {
			toast.success("Public link enabled!");
		}
		setIsTogglingPublic(false);
	};

	const handleDisablePublicLink = async () => {
		setIsTogglingPublic(true);
		const success = await disablePublicLink(columnId);
		if (success) {
			toast.success("Public link disabled");
		}
		setIsTogglingPublic(false);
	};

	const handleCopyPublicLink = async () => {
		if (!publicUrl) {return;}
		try {
			await navigator.clipboard.writeText(publicUrl);
			setPublicLinkCopied(true);
			setTimeout(() => setPublicLinkCopied(false), 2000);
		} catch (error_) {
			console.error("Failed to copy:", error_);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			void handleShare();
		}
	};

	const shareValid = validateAccountId(shareInput);
	const eyebrow = "text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase";

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				<button
					className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground"
					type="button"
					aria-label="Share column"
					title="Share column"
				>
					<Share2 className="size-4 stroke-[1.75]" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				collisionPadding={12}
				className="w-[min(20rem,calc(100vw-1.5rem))] p-0 outline-none"
				onOpenAutoFocus={(event) => {
					if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
						event.preventDefault();
					}
				}}
			>
				<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
					<Share2 className="size-4 stroke-[1.75] text-muted-foreground" />
					<h3 className="text-[13px] font-semibold">Share column</h3>
				</div>
				<div className="flex flex-col gap-4 p-3">
					<section className="flex flex-col gap-2">
						<h4 className={eyebrow}>Share with account</h4>
						<div className="flex">
							<Input
								aria-label="Account ID"
								placeholder="0000 0000 0000 0000"
								value={shareInput}
								onChange={handleInputChange}
								onKeyDown={handleKeyDown}
								disabled={isSharing}
								className="h-8 rounded-r-none font-mono text-[13px] tracking-[0.06em] tabular-nums focus-visible:z-10"
								maxLength={19}
								inputMode="numeric"
							/>
							<Button
								size="sm"
								variant={shareValid ? "default" : "outline"}
								onClick={() => void handleShare()}
								disabled={isSharing || !shareValid}
								className="-ml-px h-8 rounded-l-none disabled:opacity-65"
							>
								{isSharing ? "..." : "Share"}
							</Button>
						</div>
						{error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
					</section>

					{sharedWith.length > 0 && (
						<section className="flex flex-col gap-1.5">
							<h4 className={eyebrow}>Shared with</h4>
							<ul className="flex flex-col">
								{sharedWith.map((accountId) => (
									<li
										key={accountId}
										className="group -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-muted/60"
									>
										<span
											aria-hidden
											className="size-5 shrink-0 rounded-full ring-1 ring-black/5 dark:ring-white/10"
											style={{ backgroundColor: accountColor(accountId) }}
										/>
										<span className="min-w-0 flex-1 truncate font-mono text-[13px] tabular-nums">
											{truncateAccountId(accountId)}
										</span>
										<Button
											variant="ghost"
											size="icon-sm"
											onClick={() => void handleRevoke(accountId)}
											aria-label={`Revoke access for ${truncateAccountId(accountId)}`}
											title="Revoke access"
											className="size-6 text-muted-foreground hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
										>
											<X className="size-3.5" />
										</Button>
									</li>
								))}
							</ul>
						</section>
					)}

					<section className="flex flex-col gap-2 border-t border-border/60 pt-3">
						<div className="flex items-center gap-2">
							<h4 className={eyebrow}>Public link</h4>
							{publicId && (
								<span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
									<span aria-hidden className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.18)]" />
									Live
								</span>
							)}
						</div>
						{publicId ? (
							<>
								<div className="flex h-8 items-center rounded-md border border-input bg-muted/40 pl-2.5">
									<span className="min-w-0 flex-1 truncate font-mono text-xs" title={publicUrl ?? undefined}>
										{publicUrl}
									</span>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void handleCopyPublicLink()}
										aria-label={publicLinkCopied ? "Copied public link" : "Copy public link"}
										title="Copy link"
										className="size-7 shrink-0"
									>
										{publicLinkCopied ? (
											<Check className="size-3.5 text-emerald-500" />
										) : (
											<Copy className="size-3.5" />
										)}
									</Button>
								</div>
								<div className="flex gap-1.5">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => void handleEnablePublicLink()}
										disabled={isTogglingPublic}
										className="h-7 flex-1 gap-1.5 text-xs"
									>
										<RefreshCw className="size-3.5" />
										Regenerate
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => void handleDisablePublicLink()}
										disabled={isTogglingPublic}
										className="h-7 flex-1 gap-1.5 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
									>
										<Unlink className="size-3.5" />
										Disable
									</Button>
								</div>
							</>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void handleEnablePublicLink()}
								disabled={isTogglingPublic}
								className="w-full gap-1.5"
							>
								<Link className="size-3.5" />
								{isTogglingPublic ? "Enabling..." : "Enable public link"}
							</Button>
						)}
						<p className="text-xs text-muted-foreground">
							Anyone with the link can view (read-only)
						</p>
					</section>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** A stable color per account, so the same collaborator always looks the same. */
function accountColor(accountId: string): string {
	let hash = 0;
	for (let index = 0; index < accountId.length; index++) {
		hash = (hash * 31 + accountId.charCodeAt(index)) >>> 0;
	}
	return `oklch(0.72 0.12 ${hash % 360})`;
}
