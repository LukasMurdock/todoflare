import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { yTextToSlateElement } from "@slate-yjs/core";
import type { Value } from "platejs";
import { decodeWsMessage } from "@/lib/collaboration/websocket-protocol";
import { EMPTY_COLUMN_VALUE } from "@/types/column";

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
