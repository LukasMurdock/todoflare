import { lazy, Suspense, useRef, useState, type ChangeEvent } from "react";
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
	DropdownMenuItem,
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

export function AccountBadge() {
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
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			link.href = url;
			link.download = `todoflare-storage-recovery-${timestamp}.json`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("Failed to download storage recovery data:", err);
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
				className="h-8 gap-2 text-xs text-destructive"
				onClick={handleDownloadStorageRecovery}
				title={syncStateSummary.storageLastError ?? "Browser storage needs attention"}
			>
				<FileDown className="h-4 w-4" />
				Storage recovery
			</Button>
		);
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
			if (b[1] === a[1]) return a[0].localeCompare(b[0]);
			return b[1] - a[1];
		})
		.slice(0, 3);
	const remainingYjsOutboxColumns = Math.max(
		0,
		yjsOutboxSummary.activeColumns - topYjsOutboxColumns.length,
	);

	const formatColumnId = (columnId: string) => {
		if (columnId.length <= 12) return columnId;
		return `${columnId.slice(0, 6)}...${columnId.slice(-4)}`;
	};

	const formatSyncTimestamp = (value: number | null) => {
		if (!value) return "Never";
		return new Date(value).toLocaleString();
	};

	const formatLatencyMs = (value: number | null) => {
		if (value === null) return "n/a";
		return `${value} ms`;
	};

	const redactColumnIdForSnapshot = (columnId: string) => {
		if (columnId.length <= 8) return "[redacted]";
		return `${columnId.slice(0, 4)}...[redacted]...${columnId.slice(-4)}`;
	};

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
		} catch (err) {
			console.error("Failed to copy sync debug snapshot:", err);
		}
	};

	const handleDownloadSyncDebugSnapshot = () => {
		try {
			const blob = new Blob([JSON.stringify(buildSyncDebugSnapshot(), null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			link.href = url;
			link.download = `todoflare-sync-debug-${timestamp}.json`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);

			setDownloadedSyncDebug(true);
			setTimeout(() => setDownloadedSyncDebug(false), 2000);
		} catch (err) {
			console.error("Failed to download sync debug snapshot:", err);
		}
	};

	const handleResetSyncTelemetry = () => {
		resetSyncTelemetry();
	};

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

	const now = Date.now();

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
						<p className="text-sm text-muted-foreground">No recently deleted columns.</p>
					) : (
						<div className="min-h-0 space-y-2 overflow-y-auto">
							{deletedColumns.map((item) => {
								const expiresAt = item.deletedAt + 30 * 24 * 60 * 60 * 1000;
								const remainingDays = Math.max(
									0,
									Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)),
								);

							const handleRestore = async () => {
								await restoreColumn(item.columnId);
							};

							return (
								<div
									key={`${item.columnId}-${item.deletedAt}`}
									className="rounded border p-2"
								>
									<p className="font-mono text-xs">{item.columnId}</p>
									<p className="text-xs text-muted-foreground">
										Expires in {remainingDays} day{remainingDays === 1 ? "" : "s"}
									</p>
									<Button
										variant="outline"
										size="sm"
										onClick={handleRestore}
										className="mt-2 h-7 px-2"
									>
										Restore
									</Button>
								</div>
							);
							})}
						</div>
					)}
				</DialogContent>
			</Dialog>

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
					<p className="text-muted-foreground">{effectiveStatusText}</p>
					<p className="text-muted-foreground">Mode: {syncModeText}</p>
					<p className="text-muted-foreground">
						Mutation queue: {syncStateSummary.queueDepth}
					</p>
					<p className="text-muted-foreground">
						Yjs queue: {syncStateSummary.yjsQueueDepth}
					</p>
					{yjsOutboxSummary.heldForTrashedColumns > 0 ? (
						<p className="text-muted-foreground">
							Held for trashed columns: {yjsOutboxSummary.heldForTrashedColumns}
						</p>
					) : null}
					<p className="text-muted-foreground">
						Last server hydration: {formatSyncTimestamp(syncStateSummary.lastServerHydrationAt)}
					</p>
					<p className="text-muted-foreground">
						Last replay: {formatSyncTimestamp(syncStateSummary.lastReplayAt)}
					</p>
					<p className="text-muted-foreground">
						Replay latency: {formatLatencyMs(syncStateSummary.lastReplayLatencyMs)}
					</p>
					<p className="text-muted-foreground">
						Revoked discards: {syncStateSummary.revokeDiscardCount}
					</p>
					<p className="text-muted-foreground">
						Convergence failures: {syncStateSummary.convergenceFailureCount}
					</p>
					<p className="text-muted-foreground">
						Browser storage: {syncStateSummary.storageState}
					</p>
					{syncStateSummary.quarantinedRecords > 0 ? (
						<p className="text-destructive">
							Recoverable storage records: {syncStateSummary.quarantinedRecords}
							{syncStateSummary.quarantinedDurableMutations > 0
								? ` (${syncStateSummary.quarantinedDurableMutations} unsent)`
								: ""}
						</p>
					) : null}
					{hasPendingYjsOutbox ? (
						<>
							<p className="text-muted-foreground">
								Pending Yjs outbox: {yjsOutboxSummary.totalPending} message
								{yjsOutboxSummary.totalPending === 1 ? "" : "s"} across {" "}
								{yjsOutboxSummary.activeColumns} column
								{yjsOutboxSummary.activeColumns === 1 ? "" : "s"}
							</p>
							{topYjsOutboxColumns.length > 0 ? (
								<p className="text-muted-foreground">
									Top backlog: {" "}
									{topYjsOutboxColumns
										.map(
											([columnId, count]) =>
												`${formatColumnId(columnId)} (${count})`,
										)
										.join(", ")}
									{remainingYjsOutboxColumns > 0
										? `, +${remainingYjsOutboxColumns} more`
										: ""}
								</p>
							) : null}
						</>
					) : null}
				</TooltipContent>
				</Tooltip>

				<DropdownMenuContent align="end" className="w-56">
				<div className="px-2 py-1.5">
					<p className="text-xs text-muted-foreground">Account ID — safe to share</p>
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
				<DropdownMenuItem onClick={() => setShowCredentials(true)}>
					Passkeys and recovery
				</DropdownMenuItem>
				{authenticationStatus === "authenticated" && (
					<DropdownMenuItem onClick={() => setShowAgents(true)}>
						<Bot className="mr-2 h-4 w-4" />
						Agents
					</DropdownMenuItem>
				)}

				<DropdownMenuItem onClick={handleCopySyncDebugSnapshot}>
					{copiedSyncDebug ? (
						<Check className="mr-2 h-4 w-4 text-green-500" />
					) : (
						<Copy className="mr-2 h-4 w-4" />
					)}
					{copiedSyncDebug
						? "Copied Debug Snapshot!"
						: "Copy Sync Debug Snapshot"}
				</DropdownMenuItem>

				<DropdownMenuCheckboxItem
					checked={redactSyncDebugIds}
					onCheckedChange={(checked) => setRedactSyncDebugIds(checked === true)}
				>
					Redact IDs in Debug Snapshot
				</DropdownMenuCheckboxItem>

				<DropdownMenuItem onClick={handleDownloadSyncDebugSnapshot}>
					{downloadedSyncDebug ? (
						<Check className="mr-2 h-4 w-4 text-green-500" />
					) : (
						<FileDown className="mr-2 h-4 w-4" />
					)}
					{downloadedSyncDebug
						? "Downloaded Debug Snapshot!"
						: "Download Sync Debug Snapshot"}
				</DropdownMenuItem>

				{syncStateSummary.quarantinedRecords > 0 ? (
					<DropdownMenuItem onClick={handleDownloadStorageRecovery}>
						<FileDown className="mr-2 h-4 w-4" />
						Download Unsent Changes Recovery
					</DropdownMenuItem>
				) : null}

				<DropdownMenuItem onClick={handleExport}>
					<Download className="mr-2 h-4 w-4" />
					Export Data
				</DropdownMenuItem>

				<DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
					<Upload className="mr-2 h-4 w-4" />
					Import Data
				</DropdownMenuItem>

				<DropdownMenuItem onClick={() => setShowGarbageCan(true)}>
					<Trash2 className="mr-2 h-4 w-4" />
					Recently Deleted ({deletedColumns.length})
				</DropdownMenuItem>

				<DropdownMenuItem
					onClick={handleResetSyncTelemetry}
					disabled={!hasSyncTelemetry}
				>
					<RotateCcw className="mr-2 h-4 w-4" />
					Reset Sync Telemetry
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuItem onClick={logout} className="text-destructive">
					<LogOut className="mr-2 h-4 w-4" />
					Log Out
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<p className="px-2 py-1 font-mono text-xs text-muted-foreground">Build {formatBuild()}</p>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
