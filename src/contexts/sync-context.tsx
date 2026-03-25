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
import type {
	Account,
	ColumnMeta,
	DeletedColumn,
	ConnectionStatus,
	PresenceUser,
	SyncMessage,
	GetAccountResponse,
	CreateAccountResponse,
	CreateColumnResponse,
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

const WS_OP_SYNC = 0x01;
const WS_OP_AWARENESS = 0x02;
const WS_OP_PRESENCE = 0x03;
const WS_OP_COLUMN_DELETED = 0x04;
const WS_OP_ACCESS_REVOKED = 0x05;
const WS_OP_ERROR = 0x06;

const wsTextEncoder = new TextEncoder();
const wsTextDecoder = new TextDecoder();

function encodeWsFrame(op: number, payload?: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(1 + (payload?.byteLength ?? 0));
	out[0] = op;
	if (payload && payload.byteLength > 0) {
		out.set(payload, 1);
	}
	return out.buffer;
}

function decodeWsFrame(data: ArrayBuffer): { op: number; payload: Uint8Array } {
	const view = new Uint8Array(data);
	return { op: view[0] ?? 0, payload: view.subarray(1) };
}

function decodeWsMessage(data: ArrayBuffer): SyncMessage | null {
	const { op, payload } = decodeWsFrame(data);
	switch (op) {
		case WS_OP_SYNC:
			return { type: "sync", data: payload };
		case WS_OP_AWARENESS:
			return { type: "awareness", data: payload };
		case WS_OP_PRESENCE: {
			try {
				const parsed = JSON.parse(wsTextDecoder.decode(payload)) as {
					users: PresenceUser[];
				};
				return { type: "presence", users: parsed.users ?? [] };
			} catch {
				return null;
			}
		}
		case WS_OP_COLUMN_DELETED:
			return { type: "column-deleted" };
		case WS_OP_ACCESS_REVOKED:
			return { type: "access-revoked" };
		case WS_OP_ERROR:
			return { type: "error", message: wsTextDecoder.decode(payload) };
		default:
			return null;
	}
}

function encodeOutboundMessage(message: PendingColumnSend): ArrayBuffer {
	const op = message.kind === "sync" ? WS_OP_SYNC : WS_OP_AWARENESS;
	return encodeWsFrame(op, message.payload);
}

function flushPendingSends(conn: ColumnConnection) {
	if (conn.status !== "connected") return;
	if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
	if (conn.pendingSends.length === 0) return;

	const ws = conn.ws;
	for (const message of conn.pendingSends) {
		try {
			ws.send(encodeOutboundMessage(message));
		} catch {
			// ignore
		}
	}
	conn.pendingSends = [];
}

type PendingColumnSend =
	| { kind: "sync"; payload: Uint8Array }
	| { kind: "awareness"; payload: Uint8Array };

interface ColumnConnection {
	ws: WebSocket | null;
	status: ConnectionStatus;
	presence: PresenceUser[];
	reconnectTimeout: number | null;
	reconnectAttempts: number;
	shouldReconnect: boolean;
	nonce: number;
	pendingSends: PendingColumnSend[];
	refCount: number;
}

interface SyncContextValue {
	// Account state
	accountId: string | null;
	account: Account | null;
	isLoading: boolean;
	error: string | null;

	// Connection status
	connectionStatus: ConnectionStatus;

	// Account operations
	createAccount: () => Promise<Account | null>;
	loginWithAccountId: (id: string) => Promise<boolean>;
	logout: () => void;

	// Shared columns
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];

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
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Column WebSocket connections
	const columnConnections = useRef<Map<string, ColumnConnection>>(new Map());
	const messageCallbacks = useRef<
		Map<string, Set<(message: SyncMessage) => void>>
	>(new Map());

	// Overall connection status (derived from column connections)
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("offline");

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
			setAccount(data.account);
			setSharedColumns(data.sharedColumns || []);
			setDeletedColumns(data.deletedColumns || []);
			return data.account;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			return null;
		} finally {
			setIsLoading(false);
		}
	}, [accountId]);

	// Load account on mount if we have an account ID
	useEffect(() => {
		if (accountId) {
			fetchAccount(accountId);
		}
	}, [accountId, fetchAccount]);

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

		setAccountId(null);
		setAccount(null);
		setSharedColumns([]);
		setDeletedColumns([]);
		localStorage.removeItem(ACCOUNT_STORAGE_KEY);
		updateConnectionStatus();
	}, [updateConnectionStatus]);

	// Connect to a column's WebSocket
	const connectToColumn = useCallback(
		(columnId: string) => {
			if (!accountId) return;

			const existing = columnConnections.current.get(columnId);
			if (existing && existing.status !== "offline") {
				existing.refCount += 1;
				return; // Already connected or connecting
			}

			const connect = () => {
				const conn: ColumnConnection = columnConnections.current.get(columnId) || {
					ws: null,
					status: "connecting" as ConnectionStatus,
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
					conn.reconnectAttempts = 0;

					// Flush any queued sends from before connect.
					flushPendingSends(conn);

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
							toast.error("This column has been deleted by its owner");
						} else if (decodedMessage.type === "access-revoked") {
							toast.warning("Your access to this column has been revoked");
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
					conn.reconnectTimeout = window.setTimeout(connect, delay);
				};

				ws.onerror = () => {
					// onclose will be called after onerror
				};
			};

			connect();
		},
		[accountId, updateConnectionStatus],
	);

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
		const conn = columnConnections.current.get(columnId);
		if (!conn?.ws) return;

		const message: PendingColumnSend = { kind: "sync", payload: update };

		if (conn.ws.readyState === WebSocket.OPEN) {
			conn.ws.send(encodeOutboundMessage(message));
			return;
		}

		conn.pendingSends.push(message);
	}, []);

	const sendAwareness = useCallback((columnId: string, update: Uint8Array) => {
		const conn = columnConnections.current.get(columnId);
		if (!conn?.ws) return;

		const message: PendingColumnSend = { kind: "awareness", payload: update };

		if (conn.ws.readyState === WebSocket.OPEN) {
			conn.ws.send(encodeOutboundMessage(message));
			return;
		}

		conn.pendingSends.push(message);
	}, []);

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

		try {
			const response = await fetch("/api/column", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId }),
			});

			if (!response.ok) {
				throw new Error("Failed to create column");
			}

			const data = (await response.json()) as CreateColumnResponse;

			// Optimistically update local account state so UI feels instant.
			setAccount((prev) => {
				if (!prev) return prev;
				if (prev.columnOrder.includes(data.column.id)) return prev;
				return {
					...prev,
					columnOrder: [...prev.columnOrder, data.column.id],
				};
			});

			// Reconcile with server in the background.
			void fetchAccount(accountId);

			return data.column;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			return null;
		}
	}, [accountId, fetchAccount]);

	// Delete a column
	const deleteColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const response = await fetch(`/api/column/${columnId}`, {
					method: "DELETE",
					headers: { "X-Account-ID": accountId },
				});

				if (!response.ok) {
					throw new Error("Failed to delete column");
				}

				// Disconnect and refresh
				disconnectFromColumn(columnId);
				await fetchAccount(accountId);

				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, disconnectFromColumn, fetchAccount],
	);

	const restoreColumn = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const response = await fetch(`/api/column/${columnId}/restore`, {
					method: "POST",
					headers: { "X-Account-ID": accountId },
				});

				if (!response.ok) {
					throw new Error("Failed to restore column");
				}

				await fetchAccount(accountId);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId, fetchAccount],
	);

	// Share a column
	const shareColumn = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;

			try {
				const response = await fetch(`/api/column/${columnId}/share`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Account-ID": accountId,
					},
					body: JSON.stringify({ targetAccountId }),
				});

				if (!response.ok) {
					const data = (await response.json()) as { error: string };
					throw new Error(data.error || "Failed to share column");
				}

				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId],
	);

	// Revoke share
	const revokeShare = useCallback(
		async (columnId: string, targetAccountId: string) => {
			if (!accountId) return false;

			try {
				const response = await fetch(
					`/api/column/${columnId}/share/${normalizeAccountId(targetAccountId)}`,
					{
						method: "DELETE",
						headers: { "X-Account-ID": accountId },
					},
				);

				if (!response.ok) {
					throw new Error("Failed to revoke share");
				}

				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId],
	);

	// Enable public link
	const enablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return null;

			try {
				const response = await fetch(`/api/column/${columnId}/public`, {
					method: "POST",
					headers: { "X-Account-ID": accountId },
				});

				if (!response.ok) {
					throw new Error("Failed to enable public link");
				}

				return (await response.json()) as PublicLinkResponse;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return null;
			}
		},
		[accountId],
	);

	// Disable public link
	const disablePublicLink = useCallback(
		async (columnId: string) => {
			if (!accountId) return false;

			try {
				const response = await fetch(`/api/column/${columnId}/public`, {
					method: "DELETE",
					headers: { "X-Account-ID": accountId },
				});

				if (!response.ok) {
					throw new Error("Failed to disable public link");
				}

				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unknown error");
				return false;
			}
		},
		[accountId],
	);

	// Update column order
	const updateColumnOrder = useCallback(
		async (columnOrder: string[]) => {
			if (!accountId) return;

			try {
				await fetch(`/api/account/${normalizeAccountId(accountId)}/columns`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ columnOrder }),
				});

				setAccount((prev) => (prev ? { ...prev, columnOrder } : null));
			} catch (err) {
				console.error("Failed to update column order:", err);
			}
		},
		[accountId],
	);

	// Update hidden shared columns
	const updateHiddenSharedColumns = useCallback(
		async (hiddenSharedColumns: string[]) => {
			if (!accountId) return;

			try {
				await fetch(`/api/account/${normalizeAccountId(accountId)}/hidden`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ hiddenSharedColumns }),
				});

				setAccount((prev) =>
					prev ? { ...prev, hiddenSharedColumns } : null,
				);
			} catch (err) {
				console.error("Failed to update hidden shared columns:", err);
			}
		},
		[accountId],
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
			const stored = localStorage.getItem("todoflare-columns");
			if (stored) {
				const parsed = JSON.parse(stored);
				return Array.isArray(parsed) && parsed.length > 0;
			}
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
		createAccount,
		loginWithAccountId,
		logout,
		sharedColumns,
		deletedColumns,
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
