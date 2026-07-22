import { fromCallback } from "xstate";
import {
	decodeWsMessage,
	isWsFrameWithinLimits,
	MAX_WS_FRAME_BYTES,
	WS_PROTOCOL_V1,
} from "../collaboration/websocket-protocol";
import type { SyncMessage } from "../../types/account";

export interface ColumnSocketLike {
	binaryType: string;
	readyState: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose:
		| ((event: { code?: number; reason?: string; wasClean?: boolean }) => void)
		| null;
	onerror: (() => void) | null;
	send(data: ArrayBuffer): void;
	close(code?: number, reason?: string): void;
}

export interface ColumnSocketFrame {
	data: ArrayBuffer;
	outboxId?: string;
	requiresAck?: boolean;
}

export type ColumnSocketCommand = {
	type: "SEND_FRAME";
	frame: ColumnSocketFrame;
};

export type ColumnSocketEvent =
	| { type: "SOCKET_OPENED" }
	| {
			type: "SOCKET_CLOSED";
			code: number;
			reason: string;
			wasClean: boolean;
	  }
	| { type: "SOCKET_MESSAGE"; message: SyncMessage }
	| { type: "OUTBOX_ACKNOWLEDGED"; outboxId: string }
	| { type: "OUTBOX_REPLAYED" }
	| { type: "ACCESS_REVOKED" }
	| { type: "COLUMN_DELETED" };

export interface ColumnSocketInput {
	url: string;
	createSocket: (url: string, protocols: string[]) => ColumnSocketLike;
	loadReplayFrames: () => ColumnSocketFrame[];
	onBestEffortFrameWritten: (frame: ColumnSocketFrame) => void;
}

async function normalizeSocketData(data: unknown): Promise<ArrayBuffer | null> {
	if (data instanceof ArrayBuffer) {
		return data;
	}

	if (typeof Blob !== "undefined" && data instanceof Blob) {
		return data.arrayBuffer();
	}

	return null;
}

export const columnSocketActor = fromCallback<
	ColumnSocketCommand,
	ColumnSocketInput
>(({ input, receive, sendBack }) => {
	const socket = input.createSocket(input.url, [WS_PROTOCOL_V1]);
	socket.binaryType = "arraybuffer";

	const writeFrame = (frame: ColumnSocketFrame) => {
		if (socket.readyState !== 1) return false;
		try {
			socket.send(frame.data);
			if (!frame.requiresAck) {
				input.onBestEffortFrameWritten(frame);
			}
			return true;
		} catch {
			return false;
		}
	};

	receive((event) => {
		if (event.type === "SEND_FRAME") {
			writeFrame(event.frame);
		}
	});

	socket.onopen = () => {
		sendBack({ type: "SOCKET_OPENED" });
		for (const frame of input.loadReplayFrames()) {
			writeFrame(frame);
		}
		sendBack({ type: "OUTBOX_REPLAYED" });
	};

	socket.onmessage = (event) => {
		if (
			typeof Blob !== "undefined" &&
			event.data instanceof Blob &&
			event.data.size > MAX_WS_FRAME_BYTES
		) {
			socket.close(1009, "WebSocket payload too large");
			return;
		}
		void normalizeSocketData(event.data)
			.then((data) => {
				if (!data) return;
				if (!isWsFrameWithinLimits(data)) {
					socket.close(1009, "WebSocket payload too large");
					return;
				}
				const message = decodeWsMessage(data);
				if (!message) return;
				if (message.type === "sync-ack") {
					sendBack({
						type: "OUTBOX_ACKNOWLEDGED",
						outboxId: message.outboxId,
					});
					return;
				}
				if (message.type === "access-revoked") {
					sendBack({ type: "ACCESS_REVOKED" });
					return;
				}
				if (message.type === "column-deleted") {
					sendBack({ type: "COLUMN_DELETED" });
					return;
				}
				sendBack({ type: "SOCKET_MESSAGE", message });
			})
			.catch((error: unknown) => {
				console.error("Error handling WebSocket message:", error);
			});
	};

	socket.onclose = (event) => {
		sendBack({
			type: "SOCKET_CLOSED",
			code: event.code ?? 0,
			reason: event.reason ?? "",
			wasClean: event.wasClean ?? false,
		});
	};

	socket.onerror = () => {
		// Browsers dispatch close after an error; close owns retry behavior.
	};

	return () => {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		socket.onerror = null;
		socket.close();
	};
});
