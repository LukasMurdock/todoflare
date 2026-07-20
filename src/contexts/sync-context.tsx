import {
	createContext,
	useContext,
	useState,
	useCallback,
	useEffect,
	useRef,
	type ReactNode,
} from "react";
import { toast } from "sonner";
import { deriveSyncMode, type SyncMode } from "@/lib/sync/mode-machine";
import { getLocalFirstDb } from "@/lib/local-first/database";
import type { AccountSnapshotDoc } from "@/lib/local-first/collections";
import {
	createAccountEditCommand,
	type AccountCommandPayloadMap,
	type AccountCommandType,
	type ReplayReport,
} from "@/lib/sync/contracts";
import {
	createLocalFirstMutationQueueStorage,
	LocalMutationQueueService,
} from "@/lib/sync/mutation-queue-service";
import {
	columnIdForAccountCommand,
	summarizeReplayReport,
} from "@/lib/sync/account-command-reconciliation";
import { canApplyAccountHydration } from "@/lib/sync/account-hydration";
import {
	LOCAL_COLUMNS_STORAGE_KEY,
	parseLocalColumns,
} from "@/lib/local-column-storage";
import { startReplayScheduler } from "@/lib/sync/replay-scheduler";
import {
	createAccountCommandExecutor,
	type AccountCommandEffect,
	type AccountCommandExecutor,
} from "@/lib/sync/account-command-executor";
import {
	removeSharedWithByColumn,
	upsertSharedWithByColumn,
} from "@/lib/sync/replay-state";
import {
	flushBufferedColumnMessages,
	queueOrSendColumnMessage,
	type BufferedColumnSend,
} from "@/lib/sync/column-send-buffer";
import {
	LocalYjsUpdateOutbox,
	createLocalFirstYjsOutboxStorage,
} from "@/lib/sync/yjs-update-outbox";
import {
	decodeWsMessage,
	encodeWsFrame,
	WS_OP_AWARENESS,
	WS_OP_SYNC,
} from "@/lib/collaboration/websocket-protocol";
import type { LocalFirstDatabase } from "@/lib/local-first/database";
import type {
	Account,
	ColumnMeta,
	DeletedColumn,
	ConnectionStatus,
	PresenceUser,
	SyncMessage,
	GetAccountResponse,
	CreateAccountResponse,
	PublicLinkResponse,
	RateLimitError,
	AccountExportPayload,
} from "@/types/account";
import {
	validateAccountId,
	normalizeAccountId,
	displayAccountId,
} from "@/lib/account";

const ACCOUNT_STORAGE_KEY = "todoflare-account";
const QUEUE_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const QUEUE_RESULT_CACHE_PRUNE_INTERVAL_MS = 60 * 1000;
const MAX_PENDING_COLUMN_SENDS = 512;
const PENDING_SEND_DROP_LOG_COOLDOWN_MS = 5000;
const YJS_AWARENESS_REPLAY_MAX_AGE_MS = 30_000;
const ACCESS_LOSS_NOTICE_COOLDOWN_MS = 2000;

function encodeOutboundMessage(message: PendingColumnSend): ArrayBuffer {
	const op = message.kind === "sync" ? WS_OP_SYNC : WS_OP_AWARENESS;
	return encodeWsFrame(op, message.payload);
}

function flushPendingSends(
	conn: ColumnConnection,
	options?: { onSent?: (message: PendingColumnSend) => void },
) {
	void flushBufferedColumnMessages(conn, encodeOutboundMessage, {
		onSent: options?.onSent,
	});
}

function hasTerminalFailureForCommand(
	report: ReplayReport | null,
	queueId: string | null,
): boolean {
	if (!report || !queueId) return false;
	return report.terminalFailures.some((failure) => failure.queueId === queueId);
}

function pruneExpiredQueueResults<T>(
	cache: Map<string, CachedQueueResult<T>>,
	cutoff: number,
) {
	for (const [queueId, cached] of cache) {
		if (cached.storedAt < cutoff) {
			cache.delete(queueId);
		}
	}
}

type PendingColumnSend = BufferedColumnSend & {
	outboxId?: string;
};

interface ColumnConnection {
	ws: WebSocket | null;
	status: ConnectionStatus;
	hasEverConnected: boolean;
	presence: PresenceUser[];
	reconnectTimeout: number | null;
	reconnectAttempts: number;
	shouldReconnect: boolean;
	nonce: number;
	pendingSends: PendingColumnSend[];
	refCount: number;
}

function deriveOverallConnectionStatus(
	connections: Iterable<ColumnConnection>,
): ConnectionStatus {
	const list = Array.from(connections);
	if (list.length === 0) {
		return "offline";
	}

	const hasConnected = list.some((c) => c.status === "connected");
	if (hasConnected) {
		return "connected";
	}

	const hasConnecting = list.some((c) => c.status === "connecting");
	if (hasConnecting) {
		return "connecting";
	}

	return "offline";
}

interface CachedQueueResult<T> {
	value: T;
	storedAt: number;
}

interface PendingSendDropStats {
	syncDrops: number;
	awarenessDrops: number;
	lastLoggedAt: number;
}

interface PendingSendDropSummary {
	syncDrops: number;
	awarenessDrops: number;
	affectedColumns: number;
}

interface YjsOutboxSummary {
	totalPending: number;
	activeColumns: number;
	columnPending: Record<string, number>;
}

interface SyncStateSummary {
	queueDepth: number;
	yjsQueueDepth: number;
	lastServerHydrationAt: number | null;
	lastReplayAt: number | null;
	lastReplayLatencyMs: number | null;
	revokeDiscardCount: number;
	convergenceFailureCount: number;
}

function emptyPendingSendDropSummary(): PendingSendDropSummary {
	return {
		syncDrops: 0,
		awarenessDrops: 0,
		affectedColumns: 0,
	};
}

function summarizePendingSendDrops(
	statsByColumn: Map<string, PendingSendDropStats>,
): PendingSendDropSummary {
	let syncDrops = 0;
	let awarenessDrops = 0;

	for (const stats of statsByColumn.values()) {
		syncDrops += stats.syncDrops;
		awarenessDrops += stats.awarenessDrops;
	}

	return {
		syncDrops,
		awarenessDrops,
		affectedColumns: statsByColumn.size,
	};
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

function syncStateDocId(accountId: string | null): string {
	if (!accountId) return "sync:guest";
	return `sync:${normalizeAccountId(accountId)}`;
}

interface SyncContextValue {
	// Account state
	accountId: string | null;
	account: Account | null;
	isLoading: boolean;
	error: string | null;

	// Connection status
	connectionStatus: ConnectionStatus;
	isRealtimeDegraded: boolean;
	syncMode: SyncMode;
	syncStateSummary: SyncStateSummary;
	pendingSendDropSummary: PendingSendDropSummary;
	yjsOutboxSummary: YjsOutboxSummary;

	// Account operations
	createAccount: () => Promise<Account | null>;
	loginWithAccountId: (id: string) => Promise<boolean>;
	logout: () => void;
	resetPendingSendDropSummary: () => void;
	resetSyncTelemetry: () => void;

	// Shared columns
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	sharedWithByColumn: Record<string, string[] | undefined>;
	publicLinksByColumn: Record<string, PublicLinkResponse | null>;

	// Column connections
	connectToColumn: (columnId: string) => void;
	disconnectFromColumn: (columnId: string) => void;
	getColumnStatus: (columnId: string) => ConnectionStatus;
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
	const [accountId, setAccountId] = useState<string | null>(() => {
		try {
			return localStorage.getItem(ACCOUNT_STORAGE_KEY);
		} catch {
			return null;
		}
	});
	const [account, setAccount] = useState<Account | null>(null);
	const [sharedColumns, setSharedColumns] = useState<ColumnMeta[]>([]);
	const [deletedColumns, setDeletedColumns] = useState<DeletedColumn[]>([]);
	const [sharedWithByColumn, setSharedWithByColumn] = useState<
		Record<string, string[] | undefined>
	>({});
	const [publicLinksByColumn, setPublicLinksByColumn] = useState<
		Record<string, PublicLinkResponse | null>
	>({});
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isRealtimeDegraded, setIsRealtimeDegraded] = useState(false);
	const [mutationQueueDepth, setMutationQueueDepth] = useState(0);
	const [lastServerHydrationAt, setLastServerHydrationAt] = useState<
		number | null
	>(null);
	const [lastReplayAt, setLastReplayAt] = useState<number | null>(null);
	const [lastReplayLatencyMs, setLastReplayLatencyMs] = useState<number | null>(
		null,
	);
	const [revokeDiscardCount, setRevokeDiscardCount] = useState(0);
	const [convergenceFailureCount, setConvergenceFailureCount] = useState(0);
	const [hydratedSyncStateDocId, setHydratedSyncStateDocId] = useState<
		string | null
	>(null);
	const [pendingSendDropSummary, setPendingSendDropSummary] =
		useState<PendingSendDropSummary>(emptyPendingSendDropSummary);
	const [yjsOutboxSummary, setYjsOutboxSummary] = useState<YjsOutboxSummary>(
		emptyYjsOutboxSummary,
	);
	const [isNetworkOnline, setIsNetworkOnline] = useState(() => {
		if (typeof navigator === "undefined") return true;
		return navigator.onLine;
	});

	// Column WebSocket connections
	const columnConnections = useRef<Map<string, ColumnConnection>>(new Map());
	const messageCallbacks = useRef<
		Map<string, Set<(message: SyncMessage) => void>>
	>(new Map());
	const accountIdRef = useRef<string | null>(accountId);
	const accountProjectionRevisionRef = useRef(0);
	const accountHydrationGenerationRef = useRef(0);
	const pendingSendDropsByColumnRef = useRef<
		Map<string, PendingSendDropStats>
	>(new Map());
	const recentAccessLossNoticesRef = useRef<Map<string, number>>(new Map());
	const createColumnResultsByQueueIdRef = useRef<
		Map<string, CachedQueueResult<ColumnMeta>>
	>(
		new Map(),
	);
	const publicLinkResultsByQueueIdRef = useRef<
		Map<string, CachedQueueResult<PublicLinkResponse>>
	>(
		new Map(),
	);
	const localFirstDbRef = useRef<LocalFirstDatabase | null>(null);
	const accountCommandExecutorRef = useRef<AccountCommandExecutor | null>(null);
	const mutationQueueRef = useRef<LocalMutationQueueService | null>(null);
	const yjsOutboxRef = useRef<LocalYjsUpdateOutbox | null>(null);

	const reconcileAccountCommandEffect = (effect: AccountCommandEffect) => {
		switch (effect.type) {
			case "column.created":
				createColumnResultsByQueueIdRef.current.set(effect.queueId, {
					value: effect.column,
					storedAt: Date.now(),
				});
				break;
			case "column.deleted":
				setSharedWithByColumn((prev) =>
					removeSharedWithByColumn(prev, effect.columnId),
				);
				setPublicLinksByColumn((prev) => {
					if (!(effect.columnId in prev)) return prev;
					const { [effect.columnId]: _removed, ...rest } = prev;
					return rest;
				});
				break;
			case "column.sharing.updated":
				setSharedWithByColumn((prev) =>
					upsertSharedWithByColumn(
						prev,
						effect.columnId,
						effect.sharedWith,
					),
				);
				break;
			case "column.public.enabled":
				publicLinkResultsByQueueIdRef.current.set(effect.queueId, {
					value: effect.publicLink,
					storedAt: Date.now(),
				});
				setPublicLinksByColumn((prev) => {
					const existing = prev[effect.columnId];
					if (
						existing?.publicId === effect.publicLink.publicId &&
						existing.url === effect.publicLink.url
					) {
						return prev;
					}
					return { ...prev, [effect.columnId]: effect.publicLink };
				});
				break;
			case "column.public.disabled":
				setPublicLinksByColumn((prev) => {
					if (!(effect.columnId in prev)) return prev;
					const { [effect.columnId]: _removed, ...rest } = prev;
					return rest;
				});
				break;
		}
	};

	if (!accountCommandExecutorRef.current) {
		accountCommandExecutorRef.current = createAccountCommandExecutor({
			getActiveAccountId: () => accountIdRef.current,
		});
	}

	if (!mutationQueueRef.current) {
		mutationQueueRef.current = new LocalMutationQueueService({
			executor: async (mutation) => {
				const result = await accountCommandExecutorRef.current!.execute(mutation);
				for (const effect of result.effects ?? []) {
					reconcileAccountCommandEffect(effect);
				}
				return result;
			},
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

	const hydrateAccountFromLocalSnapshot = useCallback(
		async (id: string): Promise<boolean> => {
			try {
				const db = await ensureLocalFirstDb();
				const snapshot = db.collections.accountSnapshot.get(
					accountSnapshotDocId(id),
				) as AccountSnapshotDoc | undefined;
				if (!snapshot) return false;

				setAccount(snapshot.account);
				setSharedColumns(snapshot.sharedColumns || []);
				setDeletedColumns(snapshot.deletedColumns || []);
				return true;
			} catch (err) {
				console.error("Failed to hydrate account from local snapshot:", err);
				return false;
			}
		},
		[ensureLocalFirstDb],
	);

	const persistAccountLocalSnapshot = useCallback(
		async (
			id: string,
			nextAccount: Account,
			nextSharedColumns: ColumnMeta[],
			nextDeletedColumns: DeletedColumn[],
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
					hydratedAt: previousHydratedAt,
					reconciledAt: options?.reconciledAt ?? null,
				});
			} catch (err) {
				console.error("Failed to persist local account snapshot:", err);
			}
		},
		[ensureLocalFirstDb],
	);

	const loadSyncStateFromLocalStore = useCallback(
		async (id: string | null) => {
			try {
				const db = await ensureLocalFirstDb();
				const snapshot = db.collections.syncState.get(syncStateDocId(id));
				if (!snapshot) return null;

				return {
					lastServerHydrationAt: snapshot.lastServerHydrationAt,
					lastReplayAt: snapshot.lastReplayAt,
					lastReplayLatencyMs: snapshot.lastReplayLatencyMs ?? null,
					revokeDiscardCount: snapshot.revokeDiscardCount ?? 0,
					convergenceFailureCount: snapshot.convergenceFailureCount ?? 0,
				};
			} catch (err) {
				console.error("Failed to load sync state from local store:", err);
				return null;
			}
		},
		[ensureLocalFirstDb],
	);

	const persistSyncStateToLocalStore = useCallback(
		async (params: {
			accountIdValue: string | null;
			mode: SyncMode;
			queueDepth: number;
			yjsQueueDepth: number;
			lastServerHydrationAtValue: number | null;
			lastReplayAtValue: number | null;
			lastReplayLatencyMsValue: number | null;
			revokeDiscardCountValue: number;
			convergenceFailureCountValue: number;
		}) => {
			try {
				const db = await ensureLocalFirstDb();
				const docId = syncStateDocId(params.accountIdValue);
				db.collections.syncState.set(docId, {
					id: docId,
					accountId: params.accountIdValue,
					mode: params.mode,
					queueDepth: params.queueDepth,
					yjsQueueDepth: params.yjsQueueDepth,
					lastServerHydrationAt: params.lastServerHydrationAtValue,
					lastReplayAt: params.lastReplayAtValue,
					lastReplayLatencyMs: params.lastReplayLatencyMsValue,
					revokeDiscardCount: params.revokeDiscardCountValue,
					convergenceFailureCount: params.convergenceFailureCountValue,
					updatedAt: Date.now(),
				});
			} catch (err) {
				console.error("Failed to persist sync state to local store:", err);
			}
		},
		[ensureLocalFirstDb],
	);

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
		isRealtimeDegraded,
		connectionStatus,
	});
	const activeSyncStateDocId = syncStateDocId(accountId);

	const syncStateSummary: SyncStateSummary = {
		queueDepth: mutationQueueDepth,
		yjsQueueDepth: yjsOutboxSummary.totalPending,
		lastServerHydrationAt,
		lastReplayAt,
		lastReplayLatencyMs,
		revokeDiscardCount,
		convergenceFailureCount,
	};

	useEffect(() => {
		const subscription = mutationQueue.pending$().subscribe((pending) => {
			if (!accountId) {
				setMutationQueueDepth(0);
				return;
			}

			const normalizedAccountId = normalizeAccountId(accountId);
			const depth = pending.filter(
				(mutation) => normalizeAccountId(mutation.entityId) === normalizedAccountId,
			).length;
			setMutationQueueDepth(depth);
		});

		return () => {
			subscription.unsubscribe();
		};
	}, [accountId, mutationQueue]);

	useEffect(() => {
		let cancelled = false;
		setHydratedSyncStateDocId(null);
		setLastServerHydrationAt(null);
		setLastReplayAt(null);
		setLastReplayLatencyMs(null);
		setRevokeDiscardCount(0);
		setConvergenceFailureCount(0);

		void (async () => {
			const snapshot = await loadSyncStateFromLocalStore(accountId);
			if (cancelled) return;

			setLastServerHydrationAt((prev) => {
				const loaded = snapshot?.lastServerHydrationAt ?? null;
				if (loaded === null) return prev;
				if (prev === null) return loaded;
				return Math.max(prev, loaded);
			});
			setLastReplayAt((prev) => {
				const loaded = snapshot?.lastReplayAt ?? null;
				if (loaded === null) return prev;
				if (prev === null) return loaded;
				return Math.max(prev, loaded);
			});
			setLastReplayLatencyMs((prev) => {
				const loaded = snapshot?.lastReplayLatencyMs ?? null;
				if (prev !== null) return prev;
				return loaded;
			});
			setRevokeDiscardCount((prev) => {
				const loaded = snapshot?.revokeDiscardCount ?? 0;
				return Math.max(prev, loaded);
			});
			setConvergenceFailureCount((prev) => {
				const loaded = snapshot?.convergenceFailureCount ?? 0;
				return Math.max(prev, loaded);
			});
			setHydratedSyncStateDocId(activeSyncStateDocId);
		})();

		return () => {
			cancelled = true;
		};
	}, [accountId, activeSyncStateDocId, loadSyncStateFromLocalStore]);

	useEffect(() => {
		if (hydratedSyncStateDocId !== activeSyncStateDocId) return;

		void persistSyncStateToLocalStore({
			accountIdValue: accountId,
			mode: syncMode,
			queueDepth: mutationQueueDepth,
			yjsQueueDepth: yjsOutboxSummary.totalPending,
			lastServerHydrationAtValue: lastServerHydrationAt,
			lastReplayAtValue: lastReplayAt,
			lastReplayLatencyMsValue: lastReplayLatencyMs,
			revokeDiscardCountValue: revokeDiscardCount,
			convergenceFailureCountValue: convergenceFailureCount,
		});
	}, [
		activeSyncStateDocId,
		accountId,
		convergenceFailureCount,
		hydratedSyncStateDocId,
		lastReplayAt,
		lastReplayLatencyMs,
		lastServerHydrationAt,
		mutationQueueDepth,
		persistSyncStateToLocalStore,
		revokeDiscardCount,
		syncMode,
		yjsOutboxSummary.totalPending,
	]);

	useEffect(() => {
		const onOnline = () => setIsNetworkOnline(true);
		const onOffline = () => setIsNetworkOnline(false);

		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);

		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	}, []);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			const db = await ensureLocalFirstDb();
			if (cancelled) return;

			mutationQueue.swapStorage(createLocalFirstMutationQueueStorage(db));
			yjsOutbox.swapStorage(createLocalFirstYjsOutboxStorage(db));
			refreshYjsOutboxSummary();
		})();

		return () => {
			cancelled = true;
		};
	}, [
		ensureLocalFirstDb,
		mutationQueue,
		refreshYjsOutboxSummary,
		yjsOutbox,
	]);

	useEffect(() => {
		accountIdRef.current = accountId;
		pendingSendDropsByColumnRef.current.clear();
		recentAccessLossNoticesRef.current.clear();
		setPendingSendDropSummary(emptyPendingSendDropSummary());
		refreshYjsOutboxSummary();
		createColumnResultsByQueueIdRef.current.clear();
		publicLinkResultsByQueueIdRef.current.clear();
		setSharedWithByColumn({});
		setPublicLinksByColumn({});
	}, [accountId, refreshYjsOutboxSummary]);

	useEffect(() => {
		if (!accountId) return;

		let cancelled = false;
		void (async () => {
			const hydrated = await hydrateAccountFromLocalSnapshot(accountId);
			if (cancelled) return;
			if (hydrated) {
				setError(null);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [accountId, hydrateAccountFromLocalSnapshot]);

	useEffect(() => {
		const pruneCaches = () => {
			const cutoff = Date.now() - QUEUE_RESULT_CACHE_TTL_MS;
			pruneExpiredQueueResults(createColumnResultsByQueueIdRef.current, cutoff);
			pruneExpiredQueueResults(publicLinkResultsByQueueIdRef.current, cutoff);
		};

		pruneCaches();
		const timerId = window.setInterval(
			pruneCaches,
			QUEUE_RESULT_CACHE_PRUNE_INTERVAL_MS,
		);

		return () => {
			window.clearInterval(timerId);
		};
	}, []);

	const markRealtimeDegraded = useCallback((reason: string) => {
		setIsRealtimeDegraded((prev) => {
			if (prev) return prev;
			toast.warning(reason);
			return true;
		});
	}, []);

	const acknowledgeYjsOutboxMessage = useCallback(
		(message: PendingColumnSend) => {
			if (!message.outboxId) return;
			yjsOutbox.acknowledge([message.outboxId]);
			refreshYjsOutboxSummary();
		},
		[refreshYjsOutboxSummary, yjsOutbox],
	);

	const loadYjsReplayIntoPending = useCallback(
		(columnId: string, conn: ColumnConnection) => {
			if (!accountId) return;

			const replayable = yjsOutbox.getReplayableForColumn(accountId, columnId, {
				awarenessMaxAgeMs: YJS_AWARENESS_REPLAY_MAX_AGE_MS,
			});
			if (replayable.length === 0) {
				refreshYjsOutboxSummary();
				return;
			}

			const existingOutboxIds = new Set(
				conn.pendingSends
					.map((message) => message.outboxId)
					.filter((id): id is string => typeof id === "string"),
			);

			for (const entry of replayable) {
				if (existingOutboxIds.has(entry.id)) continue;

				conn.pendingSends.push({
					kind: entry.kind,
					payload: new Uint8Array(entry.updateBytes),
					outboxId: entry.id,
				});
				existingOutboxIds.add(entry.id);
			}

			refreshYjsOutboxSummary();
		},
		[accountId, refreshYjsOutboxSummary, yjsOutbox],
	);

	const resetPendingSendDropSummary = useCallback(() => {
		pendingSendDropsByColumnRef.current.clear();
		setPendingSendDropSummary(emptyPendingSendDropSummary());
	}, []);

	const resetSyncTelemetry = useCallback(() => {
		resetPendingSendDropSummary();
		setLastReplayLatencyMs(null);
		setRevokeDiscardCount(0);
		setConvergenceFailureCount(0);
	}, [resetPendingSendDropSummary]);

	const recordPendingSendDrop = useCallback(
		(
			columnId: string,
			kind: PendingColumnSend["kind"],
			pendingCount: number,
		) => {
			const now = Date.now();
			const stats = pendingSendDropsByColumnRef.current.get(columnId) ?? {
				syncDrops: 0,
				awarenessDrops: 0,
				lastLoggedAt: 0,
			};

			if (kind === "sync") {
				stats.syncDrops += 1;
			} else {
				stats.awarenessDrops += 1;
			}

			const shouldLog =
				kind === "sync" ||
				now - stats.lastLoggedAt >= PENDING_SEND_DROP_LOG_COOLDOWN_MS;
			if (shouldLog) {
				stats.lastLoggedAt = now;
				console.warn("Dropped pending column message due to backlog cap", {
					columnId,
					kind,
					pendingCount,
					maxPending: MAX_PENDING_COLUMN_SENDS,
					syncDrops: stats.syncDrops,
					awarenessDrops: stats.awarenessDrops,
				});
			}

			pendingSendDropsByColumnRef.current.set(columnId, stats);
			setPendingSendDropSummary(
				summarizePendingSendDrops(pendingSendDropsByColumnRef.current),
			);
		},
		[],
	);

	const detachColumnSync = useCallback((columnId: string) => {
		const conn = columnConnections.current.get(columnId);
		if (!conn) return;

		conn.shouldReconnect = false;
		conn.nonce += 1;
		if (conn.reconnectTimeout) {
			clearTimeout(conn.reconnectTimeout);
		}
		if (conn.ws) {
			conn.ws.close();
		}

		columnConnections.current.delete(columnId);
		pendingSendDropsByColumnRef.current.delete(columnId);
		setPendingSendDropSummary(
			summarizePendingSendDrops(pendingSendDropsByColumnRef.current),
		);
		messageCallbacks.current.delete(columnId);
		setConnectionStatus(
			deriveOverallConnectionStatus(columnConnections.current.values()),
		);
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

			setSharedColumns((prev) => prev.filter((column) => column.id !== columnId));
			setSharedWithByColumn((prev) => removeSharedWithByColumn(prev, columnId));
			setPublicLinksByColumn((prev) => {
				if (!(columnId in prev)) return prev;
				const { [columnId]: _removed, ...rest } = prev;
				return rest;
			});
			setAccount((prev) => {
				if (!prev) return prev;

				const nextColumnOrder = prev.columnOrder.filter((id) => id !== columnId);
				const nextHiddenSharedColumns = prev.hiddenSharedColumns.filter(
					(id) => id !== columnId,
				);

				if (
					nextColumnOrder.length === prev.columnOrder.length &&
					nextHiddenSharedColumns.length === prev.hiddenSharedColumns.length
				) {
					return prev;
				}

				return {
					...prev,
					columnOrder: nextColumnOrder,
					hiddenSharedColumns: nextHiddenSharedColumns,
				};
			});

			detachColumnSync(columnId);

			const discardedCount = droppedMutationCount + droppedYjsCount;
			if (reason === "revoked" && discardedCount > 0) {
				setRevokeDiscardCount((prev) => prev + discardedCount);
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
			accountId,
			detachColumnSync,
			mutationQueue,
			refreshYjsOutboxSummary,
			yjsOutbox,
		],
	);

	const enqueueAccountCommand = useCallback(
		async <T extends AccountCommandType>(
			opType: T,
			payload: AccountCommandPayloadMap[NoInfer<T>],
		) => {
			if (!accountId) return null;
			accountProjectionRevisionRef.current += 1;

			const createdAt = Date.now();
			const command = createAccountEditCommand(opType, payload, {
				idempotencyKey: crypto.randomUUID(),
				entityId: accountId,
				createdAt,
				attemptCount: 0,
				nextRetryAt: createdAt,
			});

			return mutationQueue.enqueue(command);
		},
		[accountId, mutationQueue],
	);

	const replayMutationQueue = useCallback(async (): Promise<ReplayReport | null> => {
		if (!accountId) return null;
		if (!isNetworkOnline) return null;
		if (isRealtimeDegraded) return null;

		const replayStartedAt = Date.now();
		const report = await mutationQueue.replay({ maxBatch: 50 });
		if (report.attempted > 0) {
			const replayFinishedAt = Date.now();
			setLastReplayAt(replayFinishedAt);
			setLastReplayLatencyMs(Math.max(0, replayFinishedAt - replayStartedAt));
		}

		const reconciliation = summarizeReplayReport(report);
		const { ackedCreatedColumnIds } = reconciliation;
		if (ackedCreatedColumnIds.length > 0) {
			const createdSet = new Set(ackedCreatedColumnIds);
			setAccount((prev) => {
				if (!prev) return prev;

				const nextOrder = [...prev.columnOrder];
				let changed = false;
				for (const columnId of createdSet) {
					if (nextOrder.includes(columnId)) continue;
					nextOrder.push(columnId);
					changed = true;
				}

				if (!changed) return prev;
				return { ...prev, columnOrder: nextOrder };
			});
		}

		const { failedCreatedColumnIds } = reconciliation;
		if (failedCreatedColumnIds.length > 0) {
			const failedSet = new Set(failedCreatedColumnIds);
			setAccount((prev) => {
				if (!prev) return prev;

				const nextOrder = prev.columnOrder.filter(
					(columnId) => !failedSet.has(columnId),
				);
				if (nextOrder.length === prev.columnOrder.length) {
					return prev;
				}

				return { ...prev, columnOrder: nextOrder };
			});
		}

		for (const failure of report.terminalFailures) {
			createColumnResultsByQueueIdRef.current.delete(failure.queueId);
			publicLinkResultsByQueueIdRef.current.delete(failure.queueId);
		}

		for (const revokedColumnId of reconciliation.accessLostColumnIds) {
			await applyColumnAccessLossPolicy(revokedColumnId, "revoked", "replay");
		}

		if (reconciliation.nonAccessLossFailureCount > 0) {
			setConvergenceFailureCount(
				(prev) => prev + reconciliation.nonAccessLossFailureCount,
			);
			setError("Some offline changes could not be synced");
			toast.error("Some offline changes could not be synced");
		}
		return report;
	}, [
		accountId,
		applyColumnAccessLossPolicy,
		isNetworkOnline,
		isRealtimeDegraded,
		mutationQueue,
	]);

	useEffect(() => {
		if (!accountId) return;
		if (!isNetworkOnline) return;
		if (isRealtimeDegraded) return;

		return startReplayScheduler(replayMutationQueue, {
			enableE2eWake: import.meta.env.VITE_E2E_REPLAY_CONTROL === "true",
		});
	}, [accountId, isNetworkOnline, isRealtimeDegraded, replayMutationQueue]);

	// Update overall connection status based on column connections
	const updateConnectionStatus = useCallback(() => {
		const connections = Array.from(columnConnections.current.values());
		if (connections.length === 0) {
			setConnectionStatus("offline");
			return;
		}

		const hasConnected = connections.some((c) => c.status === "connected");
		const hasConnecting = connections.some((c) => c.status === "connecting");

		if (hasConnected) {
			setConnectionStatus("connected");
		} else if (hasConnecting) {
			setConnectionStatus("connecting");
		} else {
			setConnectionStatus("offline");
		}
	}, []);

	// Fetch account data
	const fetchAccount = useCallback(async (id: string) => {
		const guard = {
			accountId: id,
			projectionRevision: accountProjectionRevisionRef.current,
			requestGeneration: ++accountHydrationGenerationRef.current,
		};
		try {
			setIsLoading(true);
			setError(null);

			const response = await fetch(`/api/account/${normalizeAccountId(id)}`);

			if (!response.ok) {
				if (response.status === 404) {
					const requestedId = normalizeAccountId(id);
					const currentId = accountId ? normalizeAccountId(accountId) : null;

					if (currentId && currentId === requestedId) {
						setAccountId(null);
						setAccount(null);
						setSharedColumns([]);
						setDeletedColumns([]);
						try {
							localStorage.removeItem(ACCOUNT_STORAGE_KEY);
						} catch {
							// ignore
						}
					}

					throw new Error("Account not found");
				}
				if (response.status === 429) {
					const data = (await response.json()) as RateLimitError;
					throw new Error(
						`Rate limited. Try again in ${data.retryAfter} seconds.`,
					);
				}
				throw new Error("Failed to fetch account");
			}

			const data = (await response.json()) as GetAccountResponse;
			const currentAccountId = accountIdRef.current;
			if (
				!currentAccountId ||
				!canApplyAccountHydration(guard, {
					accountId: currentAccountId,
					projectionRevision: accountProjectionRevisionRef.current,
					requestGeneration: accountHydrationGenerationRef.current,
				})
			) {
				return data.account;
			}
			const hydratedAt = Date.now();
			setAccount(data.account);
			setSharedColumns(data.sharedColumns || []);
			setDeletedColumns(data.deletedColumns || []);
			setLastServerHydrationAt(hydratedAt);
			await persistAccountLocalSnapshot(
				id,
				data.account,
				data.sharedColumns || [],
				data.deletedColumns || [],
				{ reconciledAt: hydratedAt },
			);
			return data.account;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			return null;
		} finally {
			setIsLoading(false);
		}
	}, [accountId, persistAccountLocalSnapshot]);

	// Load account on mount if we have an account ID
	useEffect(() => {
		if (!accountId) return;
		if (!isNetworkOnline) return;

		void fetchAccount(accountId);
	}, [accountId, fetchAccount, isNetworkOnline]);

	useEffect(() => {
		if (!accountId || !account) return;

		void persistAccountLocalSnapshot(
			accountId,
			account,
			sharedColumns,
			deletedColumns,
		);
	}, [
		accountId,
		account,
		sharedColumns,
		deletedColumns,
		persistAccountLocalSnapshot,
	]);

	// Create new account
	const createAccount = useCallback(async () => {
		try {
			setIsLoading(true);
			setError(null);

			const response = await fetch("/api/account", { method: "POST" });

			if (!response.ok) {
				if (response.status === 429) {
					const data = (await response.json()) as RateLimitError;
					throw new Error(
						`Rate limited. Try again in ${data.retryAfter} seconds.`,
					);
				}
				throw new Error("Failed to create account");
			}

			const data = (await response.json()) as CreateAccountResponse;
			const newAccount = data.account;

			setAccount(newAccount);
			setAccountId(newAccount.id);
			localStorage.setItem(ACCOUNT_STORAGE_KEY, newAccount.id);

			toast.success("Account created successfully!");
			return newAccount;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			setError(message);
			toast.error(message);
			return null;
		} finally {
			setIsLoading(false);
		}
	}, []);

	// Login with existing account ID
	const loginWithAccountId = useCallback(
		async (id: string) => {
			if (!validateAccountId(id)) {
				setError("Invalid account ID format");
				return false;
			}

			const formattedId = displayAccountId(id);
			const fetchedAccount = await fetchAccount(formattedId);

			if (fetchedAccount) {
				setAccountId(formattedId);
				localStorage.setItem(ACCOUNT_STORAGE_KEY, formattedId);
				toast.success("Logged in successfully!");
				return true;
			}

			return false;
		},
		[fetchAccount],
	);

	// Logout
	const logout = useCallback(() => {
		// Disconnect all columns
		for (const columnId of columnConnections.current.keys()) {
			const conn = columnConnections.current.get(columnId);
			if (conn?.ws) {
				conn.ws.close();
			}
			if (conn?.reconnectTimeout) {
				clearTimeout(conn.reconnectTimeout);
			}
		}
		columnConnections.current.clear();
		resetSyncTelemetry();
		recentAccessLossNoticesRef.current.clear();

		setAccountId(null);
		setAccount(null);
		setSharedColumns([]);
		setDeletedColumns([]);
		localStorage.removeItem(ACCOUNT_STORAGE_KEY);
		updateConnectionStatus();
	}, [resetSyncTelemetry, updateConnectionStatus]);

	// Connect to a column's WebSocket
	const connectToColumn = useCallback(
		(columnId: string) => {
			if (!accountId) return;
			if (isRealtimeDegraded) return;

			const existing = columnConnections.current.get(columnId);
			if (existing && existing.status !== "offline") {
				existing.refCount += 1;
				return; // Already connected or connecting
			}

			const connect = () => {
				const conn: ColumnConnection = columnConnections.current.get(columnId) || {
					ws: null,
					status: "connecting" as ConnectionStatus,
					hasEverConnected: false,
					presence: [],
					reconnectTimeout: null,
					reconnectAttempts: 0,
					shouldReconnect: true,
					nonce: 0,
					pendingSends: [],
					refCount: 0,
				};

				conn.status = "connecting";
				conn.shouldReconnect = true;
				conn.refCount = Math.max(conn.refCount, 1);
				conn.nonce += 1;
				const nonce = conn.nonce;
				columnConnections.current.set(columnId, conn);
				updateConnectionStatus();

				const wsProtocol =
					window.location.protocol === "https:" ? "wss:" : "ws:";
				const wsUrl = `${wsProtocol}//${window.location.host}/api/column/${columnId}/ws?accountId=${normalizeAccountId(accountId)}`;

				const ws = new WebSocket(wsUrl);
				ws.binaryType = "arraybuffer";
				conn.ws = ws;

				ws.onopen = () => {
					const active = columnConnections.current.get(columnId);
					if (!active || active.nonce !== nonce || active !== conn) {
						ws.close();
						return;
					}

					conn.status = "connected";
					conn.hasEverConnected = true;
					conn.reconnectAttempts = 0;

					// Rehydrate persistent Yjs outbox entries for this column.
					loadYjsReplayIntoPending(columnId, conn);

					// Flush any queued sends from before connect.
					flushPendingSends(conn, {
						onSent: acknowledgeYjsOutboxMessage,
					});

					updateConnectionStatus();
				};

				ws.onmessage = async (event) => {
					const active = columnConnections.current.get(columnId);
					if (!active || active.nonce !== nonce || active !== conn) {
						return;
					}

					try {
						let decodedMessage: SyncMessage | null = null;

						if (event.data instanceof ArrayBuffer) {
							decodedMessage = decodeWsMessage(event.data);
						} else if (event.data instanceof Blob) {
							const buffer = await event.data.arrayBuffer();
							decodedMessage = decodeWsMessage(buffer);
						} else {
							return;
						}

						if (!decodedMessage) return;

						// Handle presence updates internally
						if (decodedMessage.type === "presence") {
							conn.presence = decodedMessage.users;
						}

						// Handle special messages with toasts
						if (decodedMessage.type === "column-deleted") {
							await applyColumnAccessLossPolicy(
								columnId,
								"column_deleted",
								"websocket",
							);
							return;
						} else if (decodedMessage.type === "access-revoked") {
							await applyColumnAccessLossPolicy(
								columnId,
								"revoked",
								"websocket",
							);
							return;
						} else if (decodedMessage.type === "error") {
							toast.error(decodedMessage.message);
						}

						// Notify callbacks
						const callbacks = messageCallbacks.current.get(columnId);
						if (callbacks) {
							for (const callback of callbacks) {
								callback(decodedMessage);
							}
						}
					} catch (err) {
						console.error("Error handling WebSocket message:", err);
					}
				};

				ws.onclose = () => {
					const active = columnConnections.current.get(columnId);
					if (!active || active.nonce !== nonce || active !== conn) {
						return;
					}

					conn.status = "offline";
					conn.ws = null;
					conn.pendingSends = [];
					updateConnectionStatus();

					if (!conn.shouldReconnect || conn.refCount <= 0) return;

					// Reconnect with exponential backoff
					const delay = Math.min(
						1000 * Math.pow(2, conn.reconnectAttempts),
						30000,
					);
					conn.reconnectAttempts++;
					if (!conn.hasEverConnected && conn.reconnectAttempts >= 3) {
						markRealtimeDegraded(
							"Realtime connection failed repeatedly. Switched to local-only mode.",
						);
						return;
					}
					conn.reconnectTimeout = window.setTimeout(connect, delay);
				};

				ws.onerror = () => {
					// onclose will be called after onerror
				};
			};

			connect();
		},
		[
			acknowledgeYjsOutboxMessage,
			accountId,
			applyColumnAccessLossPolicy,
			isRealtimeDegraded,
			loadYjsReplayIntoPending,
			markRealtimeDegraded,
			updateConnectionStatus,
		],
	);

	useEffect(() => {
		if (!isRealtimeDegraded) return;

		for (const conn of columnConnections.current.values()) {
			conn.shouldReconnect = false;
			if (conn.reconnectTimeout) {
				clearTimeout(conn.reconnectTimeout);
			}
			if (conn.ws) {
				conn.ws.close();
			}
		}
		columnConnections.current.clear();
		updateConnectionStatus();
	}, [isRealtimeDegraded, updateConnectionStatus]);

	// Disconnect from a column
	const disconnectFromColumn = useCallback(
		(columnId: string) => {
				const conn = columnConnections.current.get(columnId);
				if (conn) {
					conn.refCount = Math.max(0, conn.refCount - 1);
					if (conn.refCount > 0) return;

					conn.shouldReconnect = false;
					conn.nonce += 1;
					if (conn.ws) {
						conn.ws.close();
					}
					if (conn.reconnectTimeout) {
						clearTimeout(conn.reconnectTimeout);
					}
					columnConnections.current.delete(columnId);
					pendingSendDropsByColumnRef.current.delete(columnId);
					setPendingSendDropSummary(
						summarizePendingSendDrops(pendingSendDropsByColumnRef.current),
					);
					messageCallbacks.current.delete(columnId);
					updateConnectionStatus();
				}

		},
		[updateConnectionStatus],
	);

	// Get column connection status
	const getColumnStatus = useCallback((columnId: string): ConnectionStatus => {
		return columnConnections.current.get(columnId)?.status || "offline";
	}, []);

	// Get column presence
	const getColumnPresence = useCallback(
		(columnId: string): PresenceUser[] => {
			return columnConnections.current.get(columnId)?.presence || [];
		},
		[],
	);

	// Send update to column
	const sendUpdate = useCallback((columnId: string, update: Uint8Array) => {
		let conn = columnConnections.current.get(columnId);
		if (!conn) {
			conn = {
				ws: null,
				status: "offline",
				hasEverConnected: false,
				presence: [],
				reconnectTimeout: null,
				reconnectAttempts: 0,
				shouldReconnect: true,
				nonce: 0,
				pendingSends: [],
				refCount: 0,
			};
			columnConnections.current.set(columnId, conn);
		}

		const outboxId = accountId
			? yjsOutbox.enqueue({
					accountId,
					columnId,
					kind: "sync",
					payload: update,
			  })
			: undefined;
		if (outboxId) {
			refreshYjsOutboxSummary();
		}

		const message: PendingColumnSend = {
			kind: "sync",
			payload: update,
			outboxId,
		};
		queueOrSendColumnMessage(conn, message, encodeOutboundMessage, {
			maxPendingMessages: MAX_PENDING_COLUMN_SENDS,
			dropPolicy: "drop_awareness_first",
			onSent: acknowledgeYjsOutboxMessage,
			onDrop: ({ droppedMessage, pendingCount }) => {
				recordPendingSendDrop(columnId, droppedMessage.kind, pendingCount);
			},
		});
	}, [
		accountId,
		acknowledgeYjsOutboxMessage,
		recordPendingSendDrop,
		refreshYjsOutboxSummary,
		yjsOutbox,
	]);

	const sendAwareness = useCallback((columnId: string, update: Uint8Array) => {
		let conn = columnConnections.current.get(columnId);
		if (!conn) {
			conn = {
				ws: null,
				status: "offline",
				hasEverConnected: false,
				presence: [],
				reconnectTimeout: null,
				reconnectAttempts: 0,
				shouldReconnect: true,
				nonce: 0,
				pendingSends: [],
				refCount: 0,
			};
			columnConnections.current.set(columnId, conn);
		}

		const outboxId = accountId
			? yjsOutbox.enqueue({
					accountId,
					columnId,
					kind: "awareness",
					payload: update,
			  })
			: undefined;
		if (outboxId) {
			refreshYjsOutboxSummary();
		}

		const message: PendingColumnSend = {
			kind: "awareness",
			payload: update,
			outboxId,
		};
		queueOrSendColumnMessage(conn, message, encodeOutboundMessage, {
			maxPendingMessages: MAX_PENDING_COLUMN_SENDS,
			dropPolicy: "drop_awareness_first",
			onSent: acknowledgeYjsOutboxMessage,
			onDrop: ({ droppedMessage, pendingCount }) => {
				recordPendingSendDrop(columnId, droppedMessage.kind, pendingCount);
			},
		});
	}, [
		accountId,
		acknowledgeYjsOutboxMessage,
		recordPendingSendDrop,
		refreshYjsOutboxSummary,
		yjsOutbox,
	]);

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

		setAccount((prev) => {
			if (!prev) return prev;
			if (prev.columnOrder.includes(columnId)) return prev;
			return {
				...prev,
				columnOrder: [...prev.columnOrder, columnId],
			};
		});

		try {
			const queueId = await enqueueAccountCommand("column.create", {
				columnId,
			});
			const report = await replayMutationQueue();

			if (hasTerminalFailureForCommand(report, queueId)) {
				disconnectFromColumn(columnId);
				setAccount((prev) => {
					if (!prev) return prev;
					return {
						...prev,
						columnOrder: prev.columnOrder.filter((id) => id !== columnId),
					};
				});
				await fetchAccount(accountId);
				return null;
			}

			if (!queueId) {
				return provisionalColumn;
			}

			const created = createColumnResultsByQueueIdRef.current.get(queueId);
			if (created) {
				createColumnResultsByQueueIdRef.current.delete(queueId);
				return created.value;
			}

			return provisionalColumn;
		} catch (err) {
			disconnectFromColumn(columnId);
			setAccount((prev) => {
				if (!prev) return prev;
				return {
					...prev,
					columnOrder: prev.columnOrder.filter((id) => id !== columnId),
				};
			});

			const message = err instanceof Error ? err.message : "Unknown error";
			setError(message);
			if (message.includes("Exceeded allowed duration in Durable Objects free tier")) {
				markRealtimeDegraded(
					"Realtime exceeded Durable Object limits. Using local-only mode.",
				);
			}
			return null;
		}
	}, [
		accountId,
		disconnectFromColumn,
		enqueueAccountCommand,
		fetchAccount,
		markRealtimeDegraded,
		replayMutationQueue,
	]);

	// Delete a column
	const deleteColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			disconnectFromColumn(columnId);
			const deletedAt = Date.now();
			setAccount((prev) => {
				if (!prev) return prev;
				return {
					...prev,
					columnOrder: prev.columnOrder.filter((id) => id !== columnId),
				};
			});
			setDeletedColumns((prev) => [
				{ columnId, deletedAt },
				...prev.filter((entry) => entry.columnId !== columnId),
			]);

			try {
				const queueId = await enqueueAccountCommand("column.delete", {
					columnId,
				});
				const report = await replayMutationQueue();
				if (hasTerminalFailureForCommand(report, queueId)) {
					await fetchAccount(accountId);
					return false;
				}
				return true;
			} catch (err) {
				await fetchAccount(accountId);
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[
			accountId,
			disconnectFromColumn,
			enqueueAccountCommand,
			fetchAccount,
			replayMutationQueue,
		],
	);

	const restoreColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			setDeletedColumns((prev) =>
				prev.filter((entry) => entry.columnId !== columnId),
			);
			setAccount((prev) => {
				if (!prev) return prev;
				if (prev.columnOrder.includes(columnId)) return prev;
				return {
					...prev,
					columnOrder: [...prev.columnOrder, columnId],
				};
			});

			try {
				const queueId = await enqueueAccountCommand("column.restore", {
					columnId,
				});
				const report = await replayMutationQueue();
				if (hasTerminalFailureForCommand(report, queueId)) {
					await fetchAccount(accountId);
					return false;
				}
				return true;
			} catch (err) {
				await fetchAccount(accountId);
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, enqueueAccountCommand, fetchAccount, replayMutationQueue],
	);

	// Share a column
	const shareColumn = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;
			if (!validateAccountId(targetAccountId)) return false;

			try {
				const queueId = await enqueueAccountCommand("column.share", {
					columnId,
					targetAccountId,
				});
				const report = await replayMutationQueue();
				if (!report) {
					return false;
				}
				if (hasTerminalFailureForCommand(report, queueId)) {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	// Revoke share
	const revokeShare = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;
			if (!validateAccountId(targetAccountId)) return false;

			try {
				const queueId = await enqueueAccountCommand("column.revoke", {
					columnId,
					targetAccountId,
				});
				const report = await replayMutationQueue();
				if (!report) {
					return false;
				}
				if (hasTerminalFailureForCommand(report, queueId)) {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	// Enable public link
	const enablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return null;

			try {
				const queueId = await enqueueAccountCommand("column.public.enable", {
					columnId,
				});
				const report = await replayMutationQueue();
				if (hasTerminalFailureForCommand(report, queueId)) {
					return null;
				}

				if (!queueId) {
					return null;
				}

				const result = publicLinkResultsByQueueIdRef.current.get(queueId);
				if (result) {
					publicLinkResultsByQueueIdRef.current.delete(queueId);
					return result.value;
				}

				return null;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return null;
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	// Disable public link
	const disablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const queueId = await enqueueAccountCommand("column.public.disable", {
					columnId,
				});
				const report = await replayMutationQueue();
				if (!report) {
					return false;
				}
				if (hasTerminalFailureForCommand(report, queueId)) {
					return false;
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	// Update column order
	const updateColumnOrder = useCallback(
		async (columnOrder: string[]) => {
			if (!accountId) return;

			setAccount((prev) => (prev ? { ...prev, columnOrder } : null));

			try {
				await enqueueAccountCommand("column.reorder", { columnOrder });
				await replayMutationQueue();
			} catch (err) {
				console.error("Failed to update column order:", err);
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	// Update hidden shared columns
	const updateHiddenSharedColumns = useCallback(
		async (hiddenSharedColumns: string[]) => {
			if (!accountId) return;

			setAccount((prev) =>
				prev ? { ...prev, hiddenSharedColumns } : null,
			);

			try {
				await enqueueAccountCommand("column.hide_shared", {
					hiddenSharedColumns,
				});
				await replayMutationQueue();
			} catch (err) {
				console.error("Failed to update hidden shared columns:", err);
			}
		},
		[accountId, enqueueAccountCommand, replayMutationQueue],
	);

	const exportAccountData = useCallback(async () => {
		if (!accountId) return null;

		try {
			const response = await fetch(
				`/api/account/${normalizeAccountId(accountId)}/export`,
				{
					headers: { "X-Account-ID": accountId },
				},
			);

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
					`/api/account/${normalizeAccountId(accountId)}/import`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Account-ID": accountId,
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
		isRealtimeDegraded,
		syncMode,
		syncStateSummary,
		pendingSendDropSummary,
		yjsOutboxSummary,
		createAccount,
		loginWithAccountId,
		logout,
		resetPendingSendDropSummary,
		resetSyncTelemetry,
		sharedColumns,
		deletedColumns,
		sharedWithByColumn,
		publicLinksByColumn,
		connectToColumn,
		disconnectFromColumn,
		getColumnStatus,
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
