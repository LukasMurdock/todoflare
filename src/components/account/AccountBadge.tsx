import { useCurrentMinute } from "@/hooks/use-current-minute";
import { lazy, Suspense, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
	Copy,
	LogOut,
	Check,
	Download,
	FileDown,
	Upload,
	Trash2,
	RotateCcw,
	Bot,
	KeyRound,
	Eraser,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { useAccount } from "@/hooks/useAccount";
import { truncateAccountId, displayAccountId } from "@/lib/account";
import { BUILD_INFO, formatBuild } from "@/lib/build-info";
import { columnIdForAccountCommand } from "@/lib/sync/account-command-reconciliation";
import { cn } from "@/lib/utils";
import { CredentialManager } from "./CredentialManager";
// Most visits never open it: fetched on first use, not with the board.
const AgentsDialog = lazy(() => import("@/components/agents/AgentsDialog").then((module) => ({ default: module.AgentsDialog })));

const formatColumnId = (columnId: string) => {
	if (columnId.length <= 12) {return columnId;}
	return `${columnId.slice(0, 6)}...${columnId.slice(-4)}`;
};

const formatSyncTimestamp = (value: number | null) => {
	if (!value) {return "Never";}
	return new Date(value).toLocaleString();
};

const formatRelativeTime = (value: number | null, now: number) => {
	if (!value) {return "Never";}
	const seconds = Math.round((now - value) / 1000);
	if (seconds < 45) {return "Just now";}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {return `${minutes}m ago`;}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {return `${hours}h ago`;}
	return new Date(value).toLocaleDateString();
};

const formatLatencyMs = (value: number | null) => {
	if (value === null) {return "n/a";}
	return `${value} ms`;
};

const redactColumnIdForSnapshot = (columnId: string) => {
	if (columnId.length <= 8) {return "[redacted]";}
	return `${columnId.slice(0, 4)}...[redacted]...${columnId.slice(-4)}`;
};

export function AccountBadge() {
	const now = useCurrentMinute();
	const {
		accountId,
		connectionStatus,
		syncMode,
		syncStateSummary,
		yjsOutboxSummary,
		getPendingAccountCommands,
		logout,
		resetSyncTelemetry,
		authenticationStatus,
		restoreColumn,
		exportAccountData,
		importAccountData,
		exportStorageRecoveryData,
		deletedColumns,
	} = useAccount();
	const [copied, setCopied] = useState(false);
	const [copiedSyncDebug, setCopiedSyncDebug] = useState(false);
	const [downloadedSyncDebug, setDownloadedSyncDebug] = useState(false);
	const [redactSyncDebugIds, setRedactSyncDebugIds] = useState(true);
	const [showGarbageCan, setShowGarbageCan] = useState(false);
	const [showCredentials, setShowCredentials] = useState(false);
	const [showAgents, setShowAgents] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const handleDownloadStorageRecovery = async () => {
		try {
			const payload = await exportStorageRecoveryData();
			const blob = new Blob([JSON.stringify(payload, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
			link.href = url;
			link.download = `todoflare-storage-recovery-${timestamp}.json`;
			document.body.insertBefore(link, null);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Failed to download storage recovery data:", error);
		}
	};

	if (!accountId) {
		if (
			syncStateSummary.storageState === "checking" ||
			(syncStateSummary.storageState === "durable" &&
				syncStateSummary.quarantinedRecords === 0)
		) {
			return null;
		}
		return (
			<Button
				variant="outline"
				size="sm"
				className="h-7 gap-1.5 rounded-full border-red-500/30 bg-background/85 px-2.5 text-xs text-red-600 shadow-raised backdrop-blur-md hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
				onClick={() => void handleDownloadStorageRecovery()}
				title={syncStateSummary.storageLastError ?? "Browser storage needs attention"}
			>
				<FileDown className="size-3.5" />
				Storage recovery
			</Button>
		);
	}

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(displayAccountId(accountId));
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (error) {
			console.error("Failed to copy:", error);
		}
	};

	const authRequired = authenticationStatus === "required";
	const statusDot = authRequired
		? "bg-red-500"
		: {
				connected: "bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.18)]",
				connecting: "bg-amber-500 animate-pulse",
				offline: "border border-muted-foreground/70 bg-transparent",
			}[connectionStatus];

	const statusText = {
		connected: "Connected",
		connecting: "Connecting...",
		offline: "Offline",
	}[connectionStatus];

	const effectiveStatusText = authenticationStatus === "required" ? "Sign-in required" : statusText;

	const syncModeText = {
		guest_local: "Guest local",
		account_offline: "Account offline",
		account_syncing: "Account syncing",
		account_auth_required: "Sign-in required",
		account_realtime: "Account realtime",
		public_readonly: "Public readonly",
	}[syncMode];

	const hasSyncTelemetry =
		syncStateSummary.lastReplayLatencyMs !== null ||
		syncStateSummary.revokeDiscardCount > 0 ||
		syncStateSummary.convergenceFailureCount > 0 ||
		syncStateSummary.storageState !== "durable" ||
		syncStateSummary.quarantinedRecords > 0;
	const hasPendingYjsOutbox = yjsOutboxSummary.totalPending > 0;
	const topYjsOutboxColumns = Object.entries(yjsOutboxSummary.columnPending)
		.sort((a, b) => {
			if (b[1] === a[1]) {return a[0].localeCompare(b[0]);}
			return b[1] - a[1];
		})
		.slice(0, 3);
	const remainingYjsOutboxColumns = Math.max(
		0,
		yjsOutboxSummary.activeColumns - topYjsOutboxColumns.length,
	);

	const buildSyncDebugSnapshot = () => {
		const displayedAccountId = displayAccountId(accountId);
		const snapshotAccountId = redactSyncDebugIds
			? truncateAccountId(displayedAccountId)
			: displayedAccountId;

		return {
			capturedAt: new Date().toISOString(),
			build: BUILD_INFO,
			redactedIds: redactSyncDebugIds,
			accountId: snapshotAccountId,
			networkOnline: typeof navigator === "undefined" ? null : navigator.onLine,
			sync: {
				mode: syncMode,
				connectionStatus,
				authenticationStatus,
				queueDepth: syncStateSummary.queueDepth,
				yjsQueueDepth: syncStateSummary.yjsQueueDepth,
				lastServerHydrationAt: syncStateSummary.lastServerHydrationAt,
				lastReplayAt: syncStateSummary.lastReplayAt,
				lastReplayLatencyMs: syncStateSummary.lastReplayLatencyMs,
				revokeDiscardCount: syncStateSummary.revokeDiscardCount,
				convergenceFailureCount: syncStateSummary.convergenceFailureCount,
				storageState: syncStateSummary.storageState,
				storageLastError: syncStateSummary.storageLastError,
				quarantinedRecords: syncStateSummary.quarantinedRecords,
				quarantinedDurableMutations:
					syncStateSummary.quarantinedDurableMutations,
			},
			recentSyncFailures: syncStateSummary.recentSyncFailures.map((failure) => ({
				...failure,
				failedAt: new Date(failure.failedAt).toISOString(),
				columnId:
					redactSyncDebugIds && failure.columnId
						? redactColumnIdForSnapshot(failure.columnId)
						: failure.columnId,
			})),
			pendingCommands: getPendingAccountCommands().map((command) => {
				const columnId = columnIdForAccountCommand(command);
				return {
					opType: command.opType,
					columnId:
						redactSyncDebugIds && columnId ? redactColumnIdForSnapshot(columnId) : columnId,
					createdAt: new Date(command.createdAt).toISOString(),
					attemptCount: command.attemptCount,
					nextRetryAt: new Date(command.nextRetryAt).toISOString(),
					lastError: command.lastError ?? null,
				};
			}),
			yjsOutbox: {
				totalPending: yjsOutboxSummary.totalPending,
				heldForTrashedColumns: yjsOutboxSummary.heldForTrashedColumns,
				activeColumns: yjsOutboxSummary.activeColumns,
				topColumns: topYjsOutboxColumns.map(([columnId, count]) => ({
					columnId: redactSyncDebugIds
						? redactColumnIdForSnapshot(columnId)
						: columnId,
					pending: count,
				})),
				remainingColumns: remainingYjsOutboxColumns,
			},
		};
	};

	const handleCopySyncDebugSnapshot = async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(buildSyncDebugSnapshot(), null, 2));
			setCopiedSyncDebug(true);
			setTimeout(() => setCopiedSyncDebug(false), 2000);
		} catch (error) {
			console.error("Failed to copy sync debug snapshot:", error);
		}
	};

	const handleDownloadSyncDebugSnapshot = () => {
		try {
			const blob = new Blob([JSON.stringify(buildSyncDebugSnapshot(), null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
			link.href = url;
			link.download = `todoflare-sync-debug-${timestamp}.json`;
			document.body.insertBefore(link, null);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);

			setDownloadedSyncDebug(true);
			setTimeout(() => setDownloadedSyncDebug(false), 2000);
		} catch (error) {
			console.error("Failed to download sync debug snapshot:", error);
		}
	};

	const handleResetSyncTelemetry = () => {
		resetSyncTelemetry();
	};

	const handleExport = async () => {
		const payload = await exportAccountData();
		if (!payload) {return;}

		const blob = new Blob([JSON.stringify(payload, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
		link.href = url;
		link.download = `todoflare-export-${timestamp}.json`;
		document.body.insertBefore(link, null);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	const handleImportSelect = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) {return;}

		try {
			const text = await file.text();
			const payload: unknown = JSON.parse(text);
			await importAccountData(payload);
		} catch (error) {
			console.error("Failed to import file:", error);
		}
	};

	const DAY_MS = 24 * 60 * 60 * 1000;
	const menuIcon = "size-4 stroke-[1.75]";
	const sectionLabel = "px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase";
	const quarantineText =
		syncStateSummary.quarantinedDurableMutations > 0
			? `${syncStateSummary.quarantinedRecords} (${syncStateSummary.quarantinedDurableMutations} unsent)`
			: `${syncStateSummary.quarantinedRecords}`;

	return (
		<>
			<CredentialManager accountId={accountId} open={showCredentials} onOpenChange={setShowCredentials} />
			{authenticationStatus === "authenticated" && showAgents && (
				<Suspense fallback={null}>
					<AgentsDialog accountId={accountId} open={showAgents} onOpenChange={setShowAgents} />
				</Suspense>
			)}
			<Dialog open={showGarbageCan} onOpenChange={setShowGarbageCan}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)]">
					<DialogHeader>
						<DialogTitle>Recently Deleted</DialogTitle>
						<DialogDescription>
							Recently deleted columns are kept for 30 days.
						</DialogDescription>
					</DialogHeader>
					{deletedColumns.length === 0 ? (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/80 px-6 py-8 text-center">
							<div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
								<Trash2 className="size-5 stroke-[1.75]" />
							</div>
							<p className="text-sm font-medium">No recently deleted columns.</p>
							<p className="text-xs text-muted-foreground">Deleted columns stay here for 30 days before they’re removed for good.</p>
						</div>
					) : (
						<ul className="min-h-0 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/70">
							{deletedColumns.map((item) => {
								const expiresAt = item.deletedAt + 30 * DAY_MS;
								const remainingDays = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
								const handleRestore = async () => {
									await restoreColumn(item.columnId);
								};
								return (
									<li
										key={`${item.columnId}-${item.deletedAt}`}
										className="flex items-center gap-3 px-3 py-2.5"
									>
										<div className="min-w-0 flex-1 space-y-1.5">
											<p className="truncate font-mono text-xs" title={item.columnId}>{item.columnId}</p>
											<div className="flex items-center gap-2">
												<div className="h-1 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
													<div
														className={cn("h-full rounded-full", remainingDays <= 3 ? "bg-amber-500" : "bg-muted-foreground/40")}
														style={{ width: `${Math.min(100, (remainingDays / 30) * 100)}%` }}
													/>
												</div>
												<p className="text-xs text-muted-foreground tabular-nums">
													Expires in {remainingDays} day{remainingDays === 1 ? "" : "s"}
												</p>
											</div>
										</div>
										<Button variant="ghost" size="sm" onClick={() => void handleRestore()} className="h-7 gap-1.5 px-2">
											<RotateCcw className="size-3.5" />
											Restore
										</Button>
									</li>
								);
							})}
						</ul>
					)}
				</DialogContent>
			</Dialog>

			<DropdownMenu>
				<input
					ref={fileInputRef}
					type="file"
					accept="application/json"
					onChange={(event) => void handleImportSelect(event)}
					className="hidden"
				/>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-2 rounded-full border border-border/70 bg-background/85 px-2.5 font-mono text-[11px] tracking-tight tabular-nums shadow-raised backdrop-blur-md hover:bg-muted data-[state=open]:bg-muted max-sm:size-9 max-sm:justify-center max-sm:px-0"
							>
								<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", statusDot)} />
								<span className="max-sm:sr-only">{truncateAccountId(accountId)}</span>
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom" align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0 text-left text-wrap">
						<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
							<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", statusDot)} />
							<span className="text-xs font-medium">{effectiveStatusText}</span>
							<span className="ml-auto rounded-full border border-border/70 bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground">
								{syncModeText}
							</span>
						</div>
						<p className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] tracking-[0.06em] text-muted-foreground tabular-nums">
							{displayAccountId(accountId)}
						</p>
						<TooltipSection title="Queue">
							<TooltipRow label="Mutation queue" value={syncStateSummary.queueDepth} warn={syncStateSummary.queueDepth > 0 ? "amber" : undefined} />
							<TooltipRow label="Yjs queue" value={syncStateSummary.yjsQueueDepth} warn={syncStateSummary.yjsQueueDepth > 0 ? "amber" : undefined} />
							{yjsOutboxSummary.heldForTrashedColumns > 0 ? (
								<TooltipRow label="Held for trashed columns" value={yjsOutboxSummary.heldForTrashedColumns} warn="amber" />
							) : null}
							{hasPendingYjsOutbox ? (
								<TooltipRow
									label="Pending Yjs outbox"
									value={`${yjsOutboxSummary.totalPending} msg${yjsOutboxSummary.totalPending === 1 ? "" : "s"} · ${yjsOutboxSummary.activeColumns} col${yjsOutboxSummary.activeColumns === 1 ? "" : "s"}`}
									warn="amber"
								/>
							) : null}
							{hasPendingYjsOutbox && topYjsOutboxColumns.length > 0 ? (
								<p className="pt-0.5 font-mono text-[10.5px] break-all text-muted-foreground">
									Top backlog:{" "}
									{topYjsOutboxColumns.map(([columnId, count]) => `${formatColumnId(columnId)} (${count})`).join(", ")}
									{remainingYjsOutboxColumns > 0 ? `, +${remainingYjsOutboxColumns} more` : ""}
								</p>
							) : null}
						</TooltipSection>
						<TooltipSection title="Last sync">
							<TooltipRow label="Server hydration" value={formatRelativeTime(syncStateSummary.lastServerHydrationAt, now)} title={formatSyncTimestamp(syncStateSummary.lastServerHydrationAt)} />
							<TooltipRow label="Replay" value={formatRelativeTime(syncStateSummary.lastReplayAt, now)} title={formatSyncTimestamp(syncStateSummary.lastReplayAt)} />
							<TooltipRow label="Replay latency" value={formatLatencyMs(syncStateSummary.lastReplayLatencyMs)} />
						</TooltipSection>
						<TooltipSection title="Health" last>
							<TooltipRow label="Revoked discards" value={syncStateSummary.revokeDiscardCount} warn={syncStateSummary.revokeDiscardCount > 0 ? "amber" : undefined} />
							<TooltipRow label="Convergence failures" value={syncStateSummary.convergenceFailureCount} warn={syncStateSummary.convergenceFailureCount > 0 ? "red" : undefined} />
							<TooltipRow label="Browser storage" value={syncStateSummary.storageState} warn={syncStateSummary.storageState === "durable" ? undefined : "amber"} />
							{syncStateSummary.quarantinedRecords > 0 ? (
								<TooltipRow label="Recoverable storage records" value={quarantineText} warn="red" />
							) : null}
						</TooltipSection>
					</TooltipContent>
				</Tooltip>

				<DropdownMenuContent align="end" collisionPadding={12} className="w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border-border/70 shadow-pop dark:ring-1 dark:ring-white/[0.06] [&_[data-slot=dropdown-menu-item]]:max-sm:py-2.5 [&_[data-slot=dropdown-menu-checkbox-item]]:max-sm:py-2.5">
					<div className="-mx-1 -mt-1 mb-1 border-b border-border/60 bg-muted/40 px-3 py-2.5">
						<p className="text-[11px] text-muted-foreground">Account ID — safe to share</p>
						<p className="font-mono text-[13px] tracking-[0.06em] tabular-nums">{displayAccountId(accountId)}</p>
					</div>

					<DropdownMenuGroup>
						<DropdownMenuLabel className={sectionLabel}>Account</DropdownMenuLabel>
						<DropdownMenuItem onClick={() => void handleCopy()}>
							{copied ? (
								<Check className={cn(menuIcon, "text-emerald-500")} />
							) : (
								<Copy className={menuIcon} />
							)}
							{copied ? "Copied!" : "Copy Account ID"}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setShowCredentials(true)}>
							<KeyRound className={menuIcon} />
							Passkeys and recovery
						</DropdownMenuItem>
						{authenticationStatus === "authenticated" && (
							<DropdownMenuItem onClick={() => setShowAgents(true)}>
								<Bot className={menuIcon} />
								Agents
							</DropdownMenuItem>
						)}
					</DropdownMenuGroup>

					<DropdownMenuSeparator className="bg-border/60" />

					<DropdownMenuGroup>
						<DropdownMenuLabel className={sectionLabel}>Data</DropdownMenuLabel>
						<DropdownMenuItem onClick={() => void handleExport()}>
							<Download className={menuIcon} />
							Export Data
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
							<Upload className={menuIcon} />
							Import Data
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setShowGarbageCan(true)}>
							<Trash2 className={menuIcon} />
							Recently Deleted
							<span className="ml-auto min-w-5 rounded-full bg-muted px-1.5 text-center text-[11px] text-muted-foreground tabular-nums">
								{deletedColumns.length}
							</span>
						</DropdownMenuItem>
						{syncStateSummary.quarantinedRecords > 0 ? (
							<DropdownMenuItem onClick={() => void handleDownloadStorageRecovery()}>
								<FileDown className={menuIcon} />
								Download Unsent Changes Recovery
							</DropdownMenuItem>
						) : null}
					</DropdownMenuGroup>

					<DropdownMenuSeparator className="bg-border/60" />

					<DropdownMenuGroup>
						<DropdownMenuLabel className={sectionLabel}>Diagnostics</DropdownMenuLabel>
						<DropdownMenuItem onClick={() => void handleCopySyncDebugSnapshot()}>
							{copiedSyncDebug ? (
								<Check className={cn(menuIcon, "text-emerald-500")} />
							) : (
								<Copy className={menuIcon} />
							)}
							{copiedSyncDebug ? "Copied Debug Snapshot!" : "Copy Sync Debug Snapshot"}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={handleDownloadSyncDebugSnapshot}>
							{downloadedSyncDebug ? (
								<Check className={cn(menuIcon, "text-emerald-500")} />
							) : (
								<FileDown className={menuIcon} />
							)}
							{downloadedSyncDebug ? "Downloaded Debug Snapshot!" : "Download Sync Debug Snapshot"}
						</DropdownMenuItem>
						<DropdownMenuCheckboxItem
							checked={redactSyncDebugIds}
							onCheckedChange={(checked) => setRedactSyncDebugIds(checked === true)}
						>
							Redact IDs in Debug Snapshot
						</DropdownMenuCheckboxItem>
						<DropdownMenuItem onClick={handleResetSyncTelemetry} disabled={!hasSyncTelemetry}>
							<Eraser className={menuIcon} />
							Reset Sync Telemetry
						</DropdownMenuItem>
					</DropdownMenuGroup>

					<DropdownMenuSeparator className="bg-border/60" />

					<DropdownMenuItem
						onClick={logout}
						className="text-red-600 focus:bg-red-500/10 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
					>
						<LogOut className={cn(menuIcon, "text-current")} />
						Log Out
					</DropdownMenuItem>

					<DropdownMenuSeparator className="bg-border/60" />

					<p className="truncate px-2 pt-1 pb-1.5 font-mono text-[10.5px] text-muted-foreground" title={`Build ${formatBuild()}`}>
						Build {formatBuild()}
					</p>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}

function TooltipSection({ title, last, children }: { title: string; last?: boolean; children: ReactNode }) {
	return (
		<div className={cn("space-y-1 px-3 py-2", !last && "border-b border-border/60")}>
			<p className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</p>
			{children}
		</div>
	);
}

function TooltipRow({
	label,
	value,
	title,
	warn,
}: {
	label: string;
	value: ReactNode;
	title?: string;
	warn?: "amber" | "red";
}) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-[11.5px]" title={title}>
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					"text-right font-mono tabular-nums",
					warn === "amber" && "text-amber-600 dark:text-amber-400",
					warn === "red" && "text-red-600 dark:text-red-400",
				)}
			>
				{value}
			</span>
		</div>
	);
}
