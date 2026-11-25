import { isSocketBuffer } from "@/lib/sync/column-socket-actor";
import { useEffect, useRef, useState } from "react";
import { Doc as YDoc, XmlText, applyUpdate } from "yjs";
import { yTextToSlateElement } from "@slate-yjs/core";
import { ElementApi } from "platejs";
import type { Value } from "platejs";
import {
	decodeWsMessage,
	isWsFrameWithinLimits,
	WS_PROTOCOL_V1,
} from "@/lib/collaboration/websocket-protocol";
import { EMPTY_COLUMN_VALUE } from "@/types/column";
import { API_ROUTES, routePath } from "@/lib/api/routes";

/**
 * Hook for read-only public column viewing
 */
export function usePublicColumnSync(publicId: string) {
	const [value, setValue] = useState<Value>(EMPTY_COLUMN_VALUE);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const docRef = useRef<YDoc | null>(null);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!publicId) {return;}

		const doc = new YDoc();
		docRef.current = doc;

		const yContent = doc.get("content", XmlText);

		// Observe changes
		const observer = () => {
			try {
				const slateValue = yTextToSlateElement(yContent);
				if (ElementApi.isElementList(slateValue.children)) {
					setValue(slateValue.children);
				}
			} catch (error_) {
				console.error("Error converting Yjs to Slate:", error_);
			}
		};

		yContent.observeDeep(observer);

		// Connect to public WebSocket
		const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${wsProtocol}//${window.location.host}${routePath(API_ROUTES.publicColumnWs.path, { publicId })}`;

		const ws = new WebSocket(wsUrl, [WS_PROTOCOL_V1]);
		ws.binaryType = "arraybuffer";
		wsRef.current = ws;

		ws.onopen = () => {
			setIsLoading(false);
		};

		ws.onmessage = (event) => {
			try {
				const data: unknown = event.data;
				if (!isSocketBuffer(data)) {return;}
				if (!isWsFrameWithinLimits(data)) {
					setError("Received an oversized collaboration message");
					ws.close();
					return;
				}
				const message = decodeWsMessage(data);
				if (!message) {return;}

				if (message.type === "sync") {
					applyUpdate(doc, message.data, "remote");
				} else if (message.type === "column-deleted") {
					setError("This column has been deleted");
				} else if (message.type === "error") {
					setError(message.message);
				}
			} catch (error_) {
				console.error("Error handling message:", error_);
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
