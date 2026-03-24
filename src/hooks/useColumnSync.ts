import { useEffect, useRef, useCallback, useState } from "react";
import * as Y from "yjs";
import { yTextToSlateElement, slateNodesToInsertDelta } from "@slate-yjs/core";
import type { Value } from "platejs";
import { useSyncContext } from "@/contexts/sync-context";
import type { SyncMessage } from "@/types/account";
import { EMPTY_COLUMN_VALUE } from "@/types/column";

const WS_OP_SYNC = 0x01;
const WS_OP_AWARENESS = 0x02;
const WS_OP_PRESENCE = 0x03;
const WS_OP_COLUMN_DELETED = 0x04;
const WS_OP_ACCESS_REVOKED = 0x05;
const WS_OP_ERROR = 0x06;

const wsTextDecoder = new TextDecoder();

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
					users: any[];
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

/**
 * Hook for syncing a column's content via Yjs
 *
 * Manages the Yjs document for a column and syncs it via WebSocket.
 * Returns the current value and a function to update it.
 */
export function useColumnSync(columnId: string) {
	const {
		accountId,
		connectToColumn,
		disconnectFromColumn,
		sendUpdate,
		onColumnMessage,
		getColumnStatus,
	} = useSyncContext();

	const docRef = useRef<Y.Doc | null>(null);
	const [value, setValue] = useState<Value>(EMPTY_COLUMN_VALUE);
	const [isInitialized, setIsInitialized] = useState(false);
	const isApplyingRemoteRef = useRef(false);

	// Initialize Yjs document
	useEffect(() => {
		if (!columnId) return;

		const doc = new Y.Doc();
		docRef.current = doc;

		// Get the shared type for content
		const yContent = doc.get("content", Y.XmlText) as Y.XmlText;

		// Observe changes to the Yjs document
		const observer = () => {
			if (isApplyingRemoteRef.current) return;

			try {
				// Convert Yjs content to Slate value
				const slateValue = yTextToSlateElement(yContent);
				if (slateValue && "children" in slateValue) {
					setValue(slateValue.children as Value);
				}
			} catch (err) {
				console.error("Error converting Yjs to Slate:", err);
			}
		};

		yContent.observeDeep(observer);

		// Listen for local updates to send to server
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			// Don't send updates that came from the server
			if (origin === "remote") return;

			sendUpdate(columnId, update);
		});

		return () => {
			yContent.unobserveDeep(observer);
			doc.destroy();
			docRef.current = null;
		};
	}, [columnId, sendUpdate]);

	// Handle incoming sync messages
	useEffect(() => {
		if (!columnId) return;

		const unsubscribe = onColumnMessage(columnId, (message: SyncMessage) => {
			if (!docRef.current) return;

			if (message.type === "sync" && message.data) {
				try {
					isApplyingRemoteRef.current = true;

					const update = message.data;
					Y.applyUpdate(docRef.current, update, "remote");

					// Update local state
					const yContent = docRef.current.get("content", Y.XmlText) as Y.XmlText;
					const slateValue = yTextToSlateElement(yContent);
					if (slateValue && "children" in slateValue) {
						setValue(slateValue.children as Value);
					}

					if (!isInitialized) {
						setIsInitialized(true);
					}
				} catch (err) {
					console.error("Error applying remote update:", err);
				} finally {
					isApplyingRemoteRef.current = false;
				}
			}
		});

		return unsubscribe;
	}, [columnId, onColumnMessage, isInitialized]);

	// Connect to the column when we have an account
	useEffect(() => {
		if (accountId && columnId) {
			connectToColumn(columnId);
		}

		return () => {
			if (columnId) {
				disconnectFromColumn(columnId);
			}
		};
	}, [accountId, columnId, connectToColumn, disconnectFromColumn]);

	// Update the Yjs document from local changes
	const updateValue = useCallback((newValue: Value) => {
		if (!docRef.current) return;

		try {
			const doc = docRef.current;
			const yContent = doc.get("content", Y.XmlText) as Y.XmlText;

			doc.transact(() => {
				// Clear existing content
				yContent.delete(0, yContent.length);

				// Insert new content
				const delta = slateNodesToInsertDelta(newValue);
				yContent.applyDelta(delta);
			});

			setValue(newValue);
		} catch (err) {
			console.error("Error updating Yjs document:", err);
		}
	}, []);

	// Get current connection status
	const connectionStatus = getColumnStatus(columnId);

	return {
		value,
		updateValue,
		isInitialized,
		connectionStatus,
	};
}

/**
 * Hook for read-only public column viewing
 */
export function usePublicColumnSync(publicId: string) {
	const [value, setValue] = useState<Value>(EMPTY_COLUMN_VALUE);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const docRef = useRef<Y.Doc | null>(null);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!publicId) return;

		const doc = new Y.Doc();
		docRef.current = doc;

		const yContent = doc.get("content", Y.XmlText) as Y.XmlText;

		// Observe changes
		const observer = () => {
			try {
				const slateValue = yTextToSlateElement(yContent);
				if (slateValue && "children" in slateValue) {
					setValue(slateValue.children as Value);
				}
			} catch (err) {
				console.error("Error converting Yjs to Slate:", err);
			}
		};

		yContent.observeDeep(observer);

		// Connect to public WebSocket
		const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${wsProtocol}//${window.location.host}/api/p/${publicId}/ws`;

		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		wsRef.current = ws;

		ws.onopen = () => {
			setIsLoading(false);
		};

		ws.onmessage = (event) => {
			try {
				if (typeof event.data === "string") return;
				const message = decodeWsMessage(event.data as ArrayBuffer);
				if (!message) return;

				if (message.type === "sync") {
					Y.applyUpdate(doc, message.data, "remote");
				} else if (message.type === "column-deleted") {
					setError("This column has been deleted");
				} else if (message.type === "error") {
					setError(message.message);
				}
			} catch (err) {
				console.error("Error handling message:", err);
			}
		};

		ws.onerror = () => {
			setError("Connection error");
			setIsLoading(false);
		};

		ws.onclose = () => {
			// Could reconnect here if needed
		};

		return () => {
			yContent.unobserveDeep(observer);
			ws.close();
			doc.destroy();
		};
	}, [publicId]);

	return {
		value,
		isLoading,
		error,
	};
}
