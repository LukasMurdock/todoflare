import type { PresenceUser, SyncMessage } from "@/types/account";

export const WS_OP_SYNC = 0x01;
export const WS_OP_AWARENESS = 0x02;
export const WS_OP_PRESENCE = 0x03;
export const WS_OP_COLUMN_DELETED = 0x04;
export const WS_OP_ACCESS_REVOKED = 0x05;
export const WS_OP_ERROR = 0x06;
export const WS_OP_SYNC_SUBMIT = 0x07;
export const WS_OP_SYNC_ACK = 0x08;

const SYNC_DELIVERY_VERSION = 1;
const SYNC_DELIVERY_HEADER_BYTES = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

export interface WebSocketFrame {
	op: number;
	payload: Uint8Array;
}

export interface DurableSyncSubmission {
	outboxId: string;
	update: Uint8Array;
}

function encodeSyncDeliveryPayload(
	outboxId: string,
	update: Uint8Array = new Uint8Array(),
): Uint8Array {
	const idBytes = textEncoder.encode(outboxId);
	if (idBytes.byteLength === 0 || idBytes.byteLength > 0xff) {
		throw new Error("Sync delivery ID must contain between 1 and 255 UTF-8 bytes");
	}

	const payload = new Uint8Array(
		SYNC_DELIVERY_HEADER_BYTES + idBytes.byteLength + update.byteLength,
	);
	payload[0] = SYNC_DELIVERY_VERSION;
	payload[1] = idBytes.byteLength;
	payload.set(idBytes, SYNC_DELIVERY_HEADER_BYTES);
	payload.set(update, SYNC_DELIVERY_HEADER_BYTES + idBytes.byteLength);
	return payload;
}

function decodeSyncDeliveryPayload(
	payload: Uint8Array,
): DurableSyncSubmission | null {
	if (payload.byteLength < SYNC_DELIVERY_HEADER_BYTES) return null;
	if (payload[0] !== SYNC_DELIVERY_VERSION) return null;

	const idLength = payload[1] ?? 0;
	const updateOffset = SYNC_DELIVERY_HEADER_BYTES + idLength;
	if (idLength === 0 || updateOffset > payload.byteLength) return null;

	try {
		const outboxId = strictTextDecoder.decode(
			payload.subarray(SYNC_DELIVERY_HEADER_BYTES, updateOffset),
		);
		if (!outboxId) return null;
		return { outboxId, update: payload.subarray(updateOffset) };
	} catch {
		return null;
	}
}

export function encodeDurableSyncSubmission(
	outboxId: string,
	update: Uint8Array,
): ArrayBuffer {
	if (update.byteLength === 0) {
		throw new Error("Durable sync submissions require a Yjs update");
	}
	return encodeWsFrame(
		WS_OP_SYNC_SUBMIT,
		encodeSyncDeliveryPayload(outboxId, update),
	);
}

export function decodeDurableSyncSubmission(
	payload: Uint8Array,
): DurableSyncSubmission | null {
	const decoded = decodeSyncDeliveryPayload(payload);
	if (!decoded || decoded.update.byteLength === 0) return null;
	return decoded;
}

export function encodeDurableSyncAck(outboxId: string): ArrayBuffer {
	return encodeWsFrame(WS_OP_SYNC_ACK, encodeSyncDeliveryPayload(outboxId));
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
		case WS_OP_SYNC_ACK: {
			const receipt = decodeSyncDeliveryPayload(payload);
			return receipt && receipt.update.byteLength === 0
				? { type: "sync-ack", outboxId: receipt.outboxId }
				: null;
		}
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
