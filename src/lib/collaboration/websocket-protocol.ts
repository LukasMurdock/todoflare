import type { PresenceUser, SyncMessage } from "@/types/account";

export const WS_OP_SYNC = 0x01;
export const WS_OP_AWARENESS = 0x02;
export const WS_OP_PRESENCE = 0x03;
export const WS_OP_COLUMN_DELETED = 0x04;
export const WS_OP_ACCESS_REVOKED = 0x05;
export const WS_OP_ERROR = 0x06;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface WebSocketFrame {
	op: number;
	payload: Uint8Array;
}

export function encodeWsFrame(
	op: number,
	payload: Uint8Array = new Uint8Array(),
): ArrayBuffer {
	const frame = new Uint8Array(1 + payload.byteLength);
	frame[0] = op;
	frame.set(payload, 1);
	return frame.buffer;
}

export function encodeWsJsonFrame(op: number, value: unknown): ArrayBuffer {
	return encodeWsFrame(op, textEncoder.encode(JSON.stringify(value)));
}

export function encodeWsTextFrame(op: number, value: string): ArrayBuffer {
	return encodeWsFrame(op, textEncoder.encode(value));
}

export function decodeWsFrame(data: ArrayBuffer): WebSocketFrame {
	const frame = new Uint8Array(data);
	return { op: frame[0] ?? 0, payload: frame.subarray(1) };
}

export function decodeWsMessage(data: ArrayBuffer): SyncMessage | null {
	const { op, payload } = decodeWsFrame(data);

	switch (op) {
		case WS_OP_SYNC:
			return { type: "sync", data: payload };
		case WS_OP_AWARENESS:
			return { type: "awareness", data: payload };
		case WS_OP_PRESENCE:
			try {
				return {
					type: "presence",
					users: (
						JSON.parse(textDecoder.decode(payload)) as {
							users?: PresenceUser[];
						}
					).users ?? [],
				};
			} catch {
				return null;
			}
		case WS_OP_COLUMN_DELETED:
			return { type: "column-deleted" };
		case WS_OP_ACCESS_REVOKED:
			return { type: "access-revoked" };
		case WS_OP_ERROR:
			return { type: "error", message: textDecoder.decode(payload) };
		default:
			return null;
	}
}
