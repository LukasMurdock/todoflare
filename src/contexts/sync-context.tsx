import {
	createContext,
	useContext,
	useState,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	type ReactNode,
} from "react";
import { waitFor } from "xstate";
import { toast } from "sonner";
import { deriveSyncMode, type SyncMode } from "@/lib/sync/mode-machine";
import { getLocalFirstDb } from "@/lib/local-first/database";
import type { AccountSnapshotDoc } from "@/lib/local-first/collections";
import {
	createLocalFirstMutationQueueStorage,
	LocalMutationQueueService,
} from "@/lib/sync/mutation-queue-service";
import { columnIdForAccountCommand } from "@/lib/sync/account-command-reconciliation";
import {
	LOCAL_COLUMNS_STORAGE_KEY,
	parseLocalColumns,
} from "@/lib/local-column-storage";
import { createAccountCommandExecutor } from "@/lib/sync/account-command-executor";
import {
	LocalYjsUpdateOutbox,
	createLocalFirstYjsOutboxStorage,
	type YjsOutboxKind,
} from "@/lib/sync/yjs-update-outbox";
import {
	encodeDurableSyncSubmission,
	encodeWsFrame,
	WS_OP_AWARENESS,
} from "@/lib/collaboration/websocket-protocol";
import { ColumnSessionManager } from "@/lib/sync/column-session-manager";
import { ColumnSocketAuthorizationError } from "@/lib/sync/column-session-machine";
import type {
	ColumnSocketFrame,
	ColumnSocketLike,
} from "@/lib/sync/column-socket-actor";
import type { AccountConvergenceDependencies } from "@/lib/sync/account-convergence-machine";
import {
	accountConvergenceErrorMessage,
	useAccountCommandSubmission,
	useAccountConvergence,
} from "@/hooks/use-account-convergence";
import {
	useSyncTelemetry,
	type SyncStateSummary,
} from "@/hooks/use-sync-telemetry";
import { projectionFromLocalSnapshot } from "@/lib/sync/account-projection";
import {
	createAccountProjection,
	fetchAccountProjection,
} from "@/lib/sync/account-api-client";
import type { LocalFirstDatabase } from "@/lib/local-first/database";
import type {
	Account,
	ColumnMeta,
	DeletedColumn,
	ConnectionStatus,
	PresenceUser,
	SyncMessage,
	PublicLinkResponse,
	AccountExportPayload,
} from "@/types/account";
import {
	validateAccountId,
	normalizeAccountId,
	displayAccountId,
} from "@/lib/account";
import { accountAuthorizationHeader } from "@/lib/http-account-auth";

const ACCOUNT_STORAGE_KEY = "todoflare-account";
const E2E_REPLAY_WAKE_EVENT = "todoflare:e2e:replay-wake";
const YJS_AWARENESS_REPLAY_MAX_AGE_MS = 30_000;
const ACCESS_LOSS_NOTICE_COOLDOWN_MS = 2000;

function encodeOutboundUpdate(
	kind: YjsOutboxKind,
	update: Uint8Array,
	outboxId: string,
): ArrayBuffer {
	if (kind === "sync") {
		return encodeDurableSyncSubmission(outboxId, update);
	}
	return encodeWsFrame(WS_OP_AWARENESS, update);
}

interface YjsOutboxSummary {
	totalPending: number;
	activeColumns: number;
	columnPending: Record<string, number>;
}

function emptyYjsOutboxSummary(): YjsOutboxSummary {
	return {
		totalPending: 0,
		activeColumns: 0,
		columnPending: {},
	};
}

function summarizeYjsOutbox(
	entries: Array<{ columnId: string }>,
): YjsOutboxSummary {
	const columnPending: Record<string, number> = {};

	for (const entry of entries) {
		columnPending[entry.columnId] = (columnPending[entry.columnId] ?? 0) + 1;
	}

	return {
		totalPending: entries.length,
		activeColumns: Object.keys(columnPending).length,
		columnPending,
	};
}

function accountSnapshotDocId(accountId: string): string {
	return `account:${normalizeAccountId(accountId)}`;
}

interface SyncContextValue {
	// Account state
	accountId: string | null;
	account: Account | null;
	isLoading: boolean;
	error: string | null;

	// Connection status
	connectionStatus: ConnectionStatus;
	syncMode: SyncMode;
	syncStateSummary: SyncStateSummary;
	yjsOutboxSummary: YjsOutboxSummary;

	// Account operations
	createAccount: () => Promise<Account | null>;
	loginWithAccountId: (id: string) => Promise<boolean>;
	logout: () => void;
	resetSyncTelemetry: () => void;

	// Shared columns
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	sharedWithByColumn: Record<string, string[] | undefined>;
	publicLinksByColumn: Record<string, PublicLinkResponse | null>;

	// Column connections
	subscribeToColumn: (columnId: string) => () => void;
	getColumnPresence: (columnId: string) => PresenceUser[];

	// Column operations (via API)
	createColumn: () => Promise<ColumnMeta | null>;
	deleteColumn: (columnId: string) => Promise<boolean>;
	restoreColumn: (columnId: string) => Promise<boolean>;
	shareColumn: (columnId: string, targetAccountId: string) => Promise<boolean>;
	revokeShare: (columnId: string, targetAccountId: string) => Promise<boolean>;
	enablePublicLink: (
		columnId: string,
	) => Promise<{ publicId: string; url: string } | null>;
	disablePublicLink: (columnId: string) => Promise<boolean>;

	// Yjs document sync
	sendUpdate: (columnId: string, update: Uint8Array) => void;
	sendAwareness: (columnId: string, update: Uint8Array) => void;
	onColumnMessage: (
		columnId: string,
		callback: (message: SyncMessage) => void,
	) => () => void;

	// Account metadata updates
	updateColumnOrder: (columnOrder: string[]) => Promise<void>;
	updateHiddenSharedColumns: (hiddenSharedColumns: string[]) => Promise<void>;
	exportAccountData: () => Promise<AccountExportPayload | null>;
	importAccountData: (payload: AccountExportPayload) => Promise<boolean>;

	// Check for existing localStorage data
	hasLocalData: () => boolean;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSyncContext() {
	const context = useContext(SyncContext);
	if (!context) {
		throw new Error("useSyncContext must be used within SyncProvider");
	}
	return context;
}

export function SyncProvider({ children }: { children: ReactNode }) {
	const restoredAccountIdRef = useRef<string | null | undefined>(undefined);
	if (restoredAccountIdRef.current === undefined) {
		try {
			restoredAccountIdRef.current = localStorage.getItem(ACCOUNT_STORAGE_KEY);
		} catch {
			restoredAccountIdRef.current = null;
		}
	}
	const [operationError, setError] = useState<string | null>(null);
	const [yjsOutboxSummary, setYjsOutboxSummary] = useState<YjsOutboxSummary>(
		emptyYjsOutboxSummary,
	);
	const [isNetworkOnline, setIsNetworkOnline] = useState(() => {
		if (typeof navigator === "undefined") return true;
		return navigator.onLine;
	});

	const columnSessionManagerRef = useRef<{
		accountId: string;
		manager: ColumnSessionManager;
	} | null>(null);
	const messageCallbacks = useRef<
		Map<string, Set<(message: SyncMessage) => void>>
	>(new Map());
	const recentAccessLossNoticesRef = useRef<Map<string, number>>(new Map());
	const accessLossSourcesRef = useRef<
		Map<string, "websocket" | "replay">
	>(new Map());
	const accessLossReconcilerRef = useRef<
		(
			columnId: string,
			reason: "revoked" | "column_deleted",
			source: "websocket" | "replay",
		) => Promise<void>
	>(async () => {});
	const localFirstDbRef = useRef<LocalFirstDatabase | null>(null);
	const accountCommandExecutorRef = useRef<ReturnType<
		typeof createAccountCommandExecutor
	> | null>(null);
	const mutationQueueRef = useRef<LocalMutationQueueService | null>(null);
	const yjsOutboxRef = useRef<LocalYjsUpdateOutbox | null>(null);
	const durableQueueStoragePromiseRef = useRef<Promise<LocalFirstDatabase> | null>(
		null,
	);

	if (!accountCommandExecutorRef.current) {
		accountCommandExecutorRef.current = createAccountCommandExecutor({});
	}

	if (!mutationQueueRef.current) {
		mutationQueueRef.current = new LocalMutationQueueService({
			executor: (mutation, options) =>
				accountCommandExecutorRef.current!.execute(mutation, options),
		});
	}

	const mutationQueue = mutationQueueRef.current!;

	if (!yjsOutboxRef.current) {
		yjsOutboxRef.current = new LocalYjsUpdateOutbox();
	}

	const yjsOutbox = yjsOutboxRef.current;

	const ensureLocalFirstDb = useCallback(async () => {
		if (localFirstDbRef.current) {
			return localFirstDbRef.current;
		}

		const db = await getLocalFirstDb();
		localFirstDbRef.current = db;
		return db;
	}, []);

	const ensureDurableQueueStorage = useCallback(() => {
		if (!durableQueueStoragePromiseRef.current) {
			durableQueueStoragePromiseRef.current = ensureLocalFirstDb().then((db) => {
				mutationQueue.swapStorage(createLocalFirstMutationQueueStorage(db));
				yjsOutbox.swapStorage(createLocalFirstYjsOutboxStorage(db));
				return db;
			});
		}
		return durableQueueStoragePromiseRef.current;
	}, [ensureLocalFirstDb, mutationQueue, yjsOutbox]);

	const persistAccountLocalSnapshot = useCallback(
		async (
			id: string,
			nextAccount: Account,
			nextSharedColumns: ColumnMeta[],
			nextDeletedColumns: DeletedColumn[],
			nextSharedWithByColumn: Record<string, string[] | undefined>,
			nextPublicLinksByColumn: Record<string, PublicLinkResponse | null>,
			options?: { reconciledAt?: number | null },
		) => {
			try {
				const db = await ensureLocalFirstDb();
				const docId = accountSnapshotDocId(id);
				const existing = db.collections.accountSnapshot.get(docId);
				const previousHydratedAt = existing?.hydratedAt ?? Date.now();

				db.collections.accountSnapshot.set(docId, {
					id: docId,
					accountId: id,
					account: nextAccount,
					sharedColumns: nextSharedColumns,
					deletedColumns: nextDeletedColumns,
					sharedWithByColumn: nextSharedWithByColumn,
					publicLinksByColumn: nextPublicLinksByColumn,
					hydratedAt: previousHydratedAt,
					reconciledAt: options?.reconciledAt ?? null,
				});
			} catch (err) {
				console.error("Failed to persist local account snapshot:", err);
			}
		},
		[ensureLocalFirstDb],
	);

	const accountConvergenceDependencies = useMemo<AccountConvergenceDependencies>(
		() => ({
			loadLocal: async (id) => {
				// Queue storage must be ready before cached columns can mount and open
				// sessions; otherwise a fast reconnect can miss durable Yjs frames.
				const db = await ensureDurableQueueStorage();
				const snapshot = db.collections.accountSnapshot.get(
					accountSnapshotDocId(id),
				) as AccountSnapshotDoc | undefined;
				if (!snapshot) return null;
				return projectionFromLocalSnapshot(snapshot);
			},
			fetchServer: (id, signal) =>
				fetchAccountProjection(id, signal, "hydrate"),
			login: (id, signal) => fetchAccountProjection(id, signal, "auth"),
			createAccount: createAccountProjection,
			replay: (id, signal) =>
				mutationQueue.replay({ accountId: id, signal, maxBatch: 50 }),
			getPending: (id) => mutationQueue.getPending(id),
			getNextRetryAt: (id) => mutationQueue.getNextRetryAt(id),
			persistCredential: (id) => {
				try {
					if (id) localStorage.setItem(ACCOUNT_STORAGE_KEY, id);
					else localStorage.removeItem(ACCOUNT_STORAGE_KEY);
				} catch {
					// Storage may be unavailable in privacy-restricted contexts.
				}
			},
			reconcileAccessLoss: async (_id, columnIds) => {
				for (const columnId of columnIds) {
					accessLossSourcesRef.current.set(columnId, "replay");
					const manager = columnSessionManagerRef.current?.manager;
					if (manager) {
						await manager.terminateColumn(columnId, "revoked");
					} else {
						await accessLossReconcilerRef.current(
							columnId,
							"revoked",
							"replay",
						);
					}
				}
			},
		}),
		[ensureDurableQueueStorage, mutationQueue],
	);
	const accountConvergence = useAccountConvergence(accountConvergenceDependencies, {
		networkOnline: isNetworkOnline,
		restoredAccountId: restoredAccountIdRef.current,
	});
	const accountConvergenceActor = accountConvergence.actor;
	const accountId = accountConvergence.accountId;
	const projection = accountConvergence.projection;
	const {
		account,
		sharedColumns,
		deletedColumns,
		sharedWithByColumn,
		publicLinksByColumn,
	} = useMemo(
		() => ({
			account: projection?.account ?? null,
			sharedColumns: projection?.sharedColumns ?? [],
			deletedColumns: projection?.deletedColumns ?? [],
			sharedWithByColumn: projection?.sharedWithByColumn ?? {},
			publicLinksByColumn: projection?.publicLinksByColumn ?? {},
		}),
		[projection],
	);
	const mutationQueueDepth = accountConvergence.queueDepth;
	const isLoading = accountConvergence.isLoading;
	const error =
		accountConvergenceErrorMessage(accountConvergence.error) ?? operationError;
	const { submitAccountCommand, waitForStableConvergence } =
		useAccountCommandSubmission(accountConvergenceActor, mutationQueue);

	const refreshYjsOutboxSummary = useCallback(() => {
		if (!accountId) {
			setYjsOutboxSummary(emptyYjsOutboxSummary());
			return;
		}

		const entries = yjsOutbox
			.getAllEntries()
			.filter((entry) => entry.accountId === accountId);
		setYjsOutboxSummary(summarizeYjsOutbox(entries));
	}, [accountId, yjsOutbox]);

	// Overall connection status (derived from column connections)
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("offline");

	const syncMode = deriveSyncMode({
		hasAccountSession: !!accountId,
		isPublicReadonly: false,
		isNetworkOnline,
		connectionStatus,
	});
	const {
		summary: syncStateSummary,
		lastServerHydrationAt,
		recordRevokeDiscard,
		resetSyncTelemetry,
	} = useSyncTelemetry({
		accountId,
		mode: syncMode,
		queueDepth: mutationQueueDepth,
		yjsQueueDepth: yjsOutboxSummary.totalPending,
		convergedAt: accountConvergence.lastConvergedAt,
		replayAt: accountConvergence.lastReplayAt,
		replayDurationMs: accountConvergence.lastReplayDurationMs,
		replayReport: accountConvergence.lastReplayReport,
		ensureLocalFirstDb,
	});

	useEffect(() => {
		setError(null);
	}, [accountId]);

	useEffect(() => {
		const onOnline = () => {
			accountConvergenceActor.send({ type: "NETWORK_ONLINE" });
			columnSessionManagerRef.current?.manager.setNetworkOnline(true);
			setIsNetworkOnline(true);
		};
		const onOffline = () => {
			accountConvergenceActor.send({ type: "NETWORK_OFFLINE" });
			columnSessionManagerRef.current?.manager.setNetworkOnline(false);
			setIsNetworkOnline(false);
		};

		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);

		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	}, [accountConvergenceActor]);

	useEffect(() => {
		if (import.meta.env.VITE_E2E_REPLAY_CONTROL !== "true") return;
		const wakeReplay = () => {
			accountConvergenceActor.send({ type: "REPLAY_WAKE" });
		};
		window.addEventListener(E2E_REPLAY_WAKE_EVENT, wakeReplay);
		return () => {
			window.removeEventListener(E2E_REPLAY_WAKE_EVENT, wakeReplay);
		};
	}, [accountConvergenceActor]);

	useEffect(() => {
		void ensureDurableQueueStorage().then(() => {
			refreshYjsOutboxSummary();
			accountConvergenceActor.send({ type: "COMMAND_PERSISTED" });
		});
	}, [
		accountConvergenceActor,
		ensureDurableQueueStorage,
		refreshYjsOutboxSummary,
	]);

	useEffect(() => {
		recentAccessLossNoticesRef.current.clear();
		refreshYjsOutboxSummary();
	}, [accountId, refreshYjsOutboxSummary]);

	const detachColumnSync = useCallback((columnId: string) => {
		columnSessionManagerRef.current?.manager.detachColumn(columnId);
		messageCallbacks.current.delete(columnId);
	}, []);

	const applyColumnAccessLossPolicy = useCallback(
		async (
			columnId: string,
			reason: "revoked" | "column_deleted",
			source: "websocket" | "replay",
		) => {
			if (!columnId) return;

			const droppedMutationCount = await mutationQueue.dropWhere(
				(mutation) => columnIdForAccountCommand(mutation) === columnId,
				reason,
			);
			const droppedYjsCount = accountId
				? yjsOutbox.dropForColumn(accountId, columnId)
				: yjsOutbox.dropWhere((entry) => entry.columnId === columnId);

			refreshYjsOutboxSummary();
			accountConvergenceActor.send({
				type: reason === "revoked" ? "ACCESS_REVOKED" : "COLUMN_DELETED",
				columnId,
			});

			const discardedCount = droppedMutationCount + droppedYjsCount;
			if (reason === "revoked" && discardedCount > 0) {
				recordRevokeDiscard(discardedCount);
			}
			const noticeKey = `${reason}:${columnId}`;
			const now = Date.now();
			const lastNotifiedAt = recentAccessLossNoticesRef.current.get(noticeKey) ?? 0;
			const shouldNotify = now - lastNotifiedAt >= ACCESS_LOSS_NOTICE_COOLDOWN_MS;
			if (!shouldNotify) return;

			recentAccessLossNoticesRef.current.set(noticeKey, now);

			if (reason === "revoked") {
				if (discardedCount > 0) {
					toast.warning("Access revoked. Unsynced changes were discarded.");
				} else if (source === "websocket") {
					toast.warning("Your access to this column has been revoked");
				}
				setError("Access revoked");
				return;
			}

			if (discardedCount > 0) {
				toast.error("This column was deleted. Unsynced changes were discarded.");
			} else if (source === "websocket") {
				toast.error("This column has been deleted by its owner");
			}
		},
		[
			accountConvergenceActor,
			accountId,
			mutationQueue,
			recordRevokeDiscard,
			refreshYjsOutboxSummary,
			yjsOutbox,
		],
	);
	accessLossReconcilerRef.current = applyColumnAccessLossPolicy;

	const ensureColumnSessionManager = useCallback(() => {
		if (!accountId) return null;
		const existing = columnSessionManagerRef.current;
		if (existing?.accountId === accountId) return existing.manager;

		existing?.manager.stop();
		const manager = new ColumnSessionManager({
			accountId,
			networkOnline: isNetworkOnline,
			realtimeEnabled: true,
			onStatusChange: setConnectionStatus,
			dependencies: {
				createSocket: (url) =>
					new WebSocket(url) as unknown as ColumnSocketLike,
				getSocketUrl: async (activeAccountId, columnId, signal) => {
					const response = await fetch(`/api/column/${columnId}/ws-ticket`, {
						method: "POST",
						signal,
						headers: {
							Authorization: accountAuthorizationHeader(activeAccountId),
						},
					});
					if ([401, 403, 404].includes(response.status)) {
						throw new ColumnSocketAuthorizationError(response.status);
					}
					if (!response.ok) throw new Error(`WebSocket ticket failed: ${response.status}`);
					const payload = (await response.json()) as { ticket?: unknown };
					if (typeof payload.ticket !== "string") {
						throw new Error("WebSocket ticket response is invalid");
					}
					const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
					return `${protocol}//${window.location.host}/api/column/${columnId}/ws?ticket=${encodeURIComponent(payload.ticket)}`;
				},
				persistUpdate: (activeAccountId, columnId, kind, update) => {
					const outboxId = yjsOutbox.enqueue({
						accountId: activeAccountId,
						columnId,
						kind,
						payload: update,
					});
					refreshYjsOutboxSummary();
					return outboxId;
				},
				loadReplayFrames: (activeAccountId, columnId) => {
					const frames = yjsOutbox
						.getReplayableForColumn(activeAccountId, columnId, {
							awarenessMaxAgeMs: YJS_AWARENESS_REPLAY_MAX_AGE_MS,
						})
						.map((entry): ColumnSocketFrame => ({
							data: encodeOutboundUpdate(
								entry.kind,
								new Uint8Array(entry.updateBytes),
								entry.id,
							),
							outboxId: entry.id,
							requiresAck: entry.kind === "sync",
						}));
					refreshYjsOutboxSummary();
					return frames;
				},
				onBestEffortFrameWritten: (frame) => {
					if (!frame.outboxId) return;
					yjsOutbox.removeAwarenessAfterSocketWrite([frame.outboxId]);
					refreshYjsOutboxSummary();
				},
				onDurableFrameAcknowledged: (activeAccountId, columnId, outboxId) => {
					yjsOutbox.acknowledgeSync(activeAccountId, columnId, outboxId);
					refreshYjsOutboxSummary();
				},
				onMessage: (columnId, message) => {
					if (message.type === "error") {
						toast.error(message.message);
					}
					for (const callback of messageCallbacks.current.get(columnId) ?? []) {
						callback(message);
					}
				},
				onTerminate: async (columnId, reason) => {
					const source = accessLossSourcesRef.current.get(columnId) ?? "websocket";
					accessLossSourcesRef.current.delete(columnId);
					await applyColumnAccessLossPolicy(columnId, reason, source);
				},
				encodeUpdate: encodeOutboundUpdate,
			},
		});

		columnSessionManagerRef.current = { accountId, manager };
		return manager;
	}, [
		accountId,
		applyColumnAccessLossPolicy,
		isNetworkOnline,
		refreshYjsOutboxSummary,
		yjsOutbox,
	]);

	const fetchAccount = useCallback(
		async (id: string) => {
			const snapshot = accountConvergenceActor.getSnapshot();
			if (
				!snapshot.context.accountId ||
				normalizeAccountId(snapshot.context.accountId) !== normalizeAccountId(id)
			) {
				return null;
			}
			accountConvergenceActor.send({ type: "REFRESH_REQUESTED" });
			const converged = await waitForStableConvergence();
			return converged.context.projection?.account ?? null;
		},
		[accountConvergenceActor, waitForStableConvergence],
	);

	useEffect(() => {
		if (!accountId || !account) return;

		void persistAccountLocalSnapshot(
			accountId,
			account,
			sharedColumns,
			deletedColumns,
			sharedWithByColumn,
			publicLinksByColumn,
			{ reconciledAt: lastServerHydrationAt },
		);
	}, [
		accountId,
		account,
		sharedColumns,
		deletedColumns,
		sharedWithByColumn,
		publicLinksByColumn,
		lastServerHydrationAt,
		persistAccountLocalSnapshot,
	]);

	const createAccount = useCallback(async () => {
		accountConvergenceActor.send({ type: "CREATE_ACCOUNT" });
		const snapshot = await waitFor(
			accountConvergenceActor,
			(state) =>
				(!!state.context.accountId &&
					!!state.context.projection &&
					!state.matches("authenticating")) ||
				(state.matches("signedOut") && state.context.error !== null),
		);
		const created = snapshot.context.projection?.account ?? null;
		if (created) {
			toast.success("Account created successfully!");
		} else {
			toast.error("Failed to create account");
		}
		return created;
	}, [accountConvergenceActor]);

	const loginWithAccountId = useCallback(
		async (id: string) => {
			if (!validateAccountId(id)) {
				setError("Invalid account ID format");
				return false;
			}
			const formattedId = displayAccountId(id);
			accountConvergenceActor.send({ type: "LOGIN", accountId: formattedId });
			const snapshot = await waitFor(
				accountConvergenceActor,
				(state) =>
					(state.context.accountId !== null &&
						normalizeAccountId(state.context.accountId) ===
							normalizeAccountId(formattedId)) ||
					(state.matches("signedOut") && state.context.error !== null),
			);
			const success =
				snapshot.context.accountId !== null &&
				normalizeAccountId(snapshot.context.accountId) ===
					normalizeAccountId(formattedId);
			if (success) toast.success("Logged in successfully!");
			return success;
		},
		[accountConvergenceActor],
	);

	// Logout
	const logout = useCallback(() => {
		columnSessionManagerRef.current?.manager.stop();
		columnSessionManagerRef.current = null;
		accountConvergenceActor.send({ type: "LOGOUT" });
		resetSyncTelemetry();
		recentAccessLossNoticesRef.current.clear();
		accessLossSourcesRef.current.clear();

		setConnectionStatus("offline");
	}, [accountConvergenceActor, resetSyncTelemetry]);

	const subscribeToColumn = useCallback(
		(columnId: string) => {
			return ensureColumnSessionManager()?.subscribeToColumn(columnId) ?? (() => {});
		},
		[ensureColumnSessionManager],
	);

	const getColumnPresence = useCallback((columnId: string): PresenceUser[] => {
		return (
			columnSessionManagerRef.current?.manager.getColumnPresence(columnId) ?? []
		);
	}, []);

	const sendUpdate = useCallback(
		(columnId: string, update: Uint8Array) => {
			ensureColumnSessionManager()?.sendSync(columnId, update);
		},
		[ensureColumnSessionManager],
	);

	const sendAwareness = useCallback(
		(columnId: string, update: Uint8Array) => {
			ensureColumnSessionManager()?.sendAwareness(columnId, update);
		},
		[ensureColumnSessionManager],
	);

	useEffect(() => {
		accountConvergenceActor.send({
			type: isNetworkOnline ? "NETWORK_ONLINE" : "NETWORK_OFFLINE",
		});
		columnSessionManagerRef.current?.manager.setNetworkOnline(isNetworkOnline);
	}, [accountConvergenceActor, isNetworkOnline]);

	useEffect(() => {
		return () => {
			const current = columnSessionManagerRef.current;
			if (!current || current.accountId !== accountId) return;
			current.manager.stop();
			columnSessionManagerRef.current = null;
		};
	}, [accountId]);

	// Subscribe to column messages
	const onColumnMessage = useCallback(
		(columnId: string, callback: (message: SyncMessage) => void) => {
			if (!messageCallbacks.current.has(columnId)) {
				messageCallbacks.current.set(columnId, new Set());
			}
			messageCallbacks.current.get(columnId)!.add(callback);

			return () => {
				messageCallbacks.current.get(columnId)?.delete(callback);
			};
		},
		[],
	);

	// Create a new column
	const createColumn = useCallback(async () => {
		if (!accountId) return null;

		const columnId = crypto.randomUUID();
		const provisionalColumn: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: displayAccountId(accountId),
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		try {
			const { outcome } = await submitAccountCommand(
				"column.create",
				{ columnId },
			);

			if (outcome === "terminal") {
				detachColumnSync(columnId);
				return null;
			}

			return provisionalColumn;
		} catch (err) {
			detachColumnSync(columnId);
			const message = err instanceof Error ? err.message : "Unknown error";
			setError(message);
			return null;
		}
	}, [accountId, detachColumnSync, submitAccountCommand]);

	// Delete a column
	const deleteColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			detachColumnSync(columnId);

			try {
				const { outcome } = await submitAccountCommand(
					"column.delete",
					{ columnId },
				);
				if (outcome === "terminal") {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, detachColumnSync, submitAccountCommand],
	);

	const restoreColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const { outcome } = await submitAccountCommand(
					"column.restore",
					{ columnId },
				);
				if (outcome === "terminal") {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, submitAccountCommand],
	);

	// Share a column
	const shareColumn = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;
			if (!validateAccountId(targetAccountId)) return false;

			try {
				const { outcome } = await submitAccountCommand(
					"column.share",
					{ columnId, targetAccountId },
				);
				if (outcome === "terminal") {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, submitAccountCommand],
	);

	// Revoke share
	const revokeShare = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;
			if (!validateAccountId(targetAccountId)) return false;

			try {
				const { outcome } = await submitAccountCommand(
					"column.revoke",
					{ columnId, targetAccountId },
				);
				if (outcome === "terminal") {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, submitAccountCommand],
	);

	// Enable public link
	const enablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return null;

			try {
				const { outcome } = await submitAccountCommand(
					"column.public.enable",
					{ columnId },
				);
				if (outcome === "terminal") {
					return null;
				}

				return (
					accountConvergenceActor.getSnapshot().context.projection
						?.publicLinksByColumn[columnId] ?? null
				);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return null;
			}
		},
		[accountConvergenceActor, accountId, submitAccountCommand],
	);

	// Disable public link
	const disablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const { outcome } = await submitAccountCommand(
					"column.public.disable",
					{ columnId },
				);
				if (outcome === "terminal") {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, submitAccountCommand],
	);

	// Update column order
	const updateColumnOrder = useCallback(
		async (columnOrder: string[]) => {
			if (!accountId) return;

			try {
				await submitAccountCommand("column.reorder", { columnOrder });
			} catch (err) {
				console.error("Failed to update column order:", err);
			}
		},
		[accountId, submitAccountCommand],
	);

	// Update hidden shared columns
	const updateHiddenSharedColumns = useCallback(
		async (hiddenSharedColumns: string[]) => {
			if (!accountId) return;

			try {
				await submitAccountCommand("column.hide_shared", {
					hiddenSharedColumns,
				});
			} catch (err) {
				console.error("Failed to update hidden shared columns:", err);
			}
		},
		[accountId, submitAccountCommand],
	);

	const exportAccountData = useCallback(async () => {
		if (!accountId) return null;

		try {
			const response = await fetch("/api/account/export", {
				headers: { Authorization: accountAuthorizationHeader(accountId) },
			});

			if (!response.ok) {
				throw new Error("Failed to export account data");
			}

			return (await response.json()) as AccountExportPayload;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			toast.error("Failed to export data");
			return null;
		}
	}, [accountId]);

	const importAccountData = useCallback(
		async (payload: AccountExportPayload) => {
			if (!accountId) return false;

			try {
				const response = await fetch(
					"/api/account/import",
					{
						method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: accountAuthorizationHeader(accountId),
						},
						body: JSON.stringify(payload),
					},
				);

				if (!response.ok) {
					throw new Error("Failed to import account data");
				}

				await fetchAccount(accountId);
				toast.success("Data imported successfully");
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				toast.error("Failed to import data");
				return false;
			}
		},
		[accountId, fetchAccount],
	);

	// Check for existing localStorage data
	const hasLocalData = useCallback(() => {
		try {
			return parseLocalColumns(
				localStorage.getItem(LOCAL_COLUMNS_STORAGE_KEY),
			) !== null;
		} catch {
			// Ignore errors
		}
		return false;
	}, []);

	const value: SyncContextValue = {
		accountId,
		account,
		isLoading,
		error,
		connectionStatus,
		syncMode,
		syncStateSummary,
		yjsOutboxSummary,
		createAccount,
		loginWithAccountId,
		logout,
		resetSyncTelemetry,
		sharedColumns,
		deletedColumns,
		sharedWithByColumn,
		publicLinksByColumn,
		subscribeToColumn,
		getColumnPresence,
		createColumn,
		deleteColumn,
		restoreColumn,
		shareColumn,
		revokeShare,
		enablePublicLink,
		disablePublicLink,
		sendUpdate,
		sendAwareness,
		onColumnMessage,
		updateColumnOrder,
		updateHiddenSharedColumns,
		exportAccountData,
		importAccountData,
		hasLocalData,
	};

	return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
