import { describe, expect, it } from "vitest";
import type { SyncMessage } from "../src/types/account";
import {
	decodeDurableSyncSubmission,
	decodeWsFrame,
	decodeWsMessage,
	encodeDurableSyncAck,
	encodeDurableSyncSubmission,
	encodeServerMessage,
	encodeWsFrame,
	encodeWsJsonFrame,
	encodeWsTextFrame,
	isWsFrameWithinLimits,
	MAX_AWARENESS_BYTES,
	MAX_OUTBOX_ID_BYTES,
	MAX_SYNC_UPDATE_BYTES,
	WS_OP_ACCESS_REVOKED,
	WS_OP_AWARENESS,
	WS_OP_COLUMN_DELETED,
	WS_OP_ERROR,
	WS_OP_PRESENCE,
	WS_OP_SYNC,
	WS_OP_SYNC_ACK,
	WS_OP_SYNC_SUBMIT,
} from "../src/lib/collaboration/websocket-protocol";

describe("WebSocket protocol", () => {
	it("keeps the established opcode values", () => {
		expect([
			WS_OP_SYNC,
			WS_OP_AWARENESS,
			WS_OP_PRESENCE,
			WS_OP_COLUMN_DELETED,
			WS_OP_ACCESS_REVOKED,
			WS_OP_ERROR,
			WS_OP_SYNC_SUBMIT,
			WS_OP_SYNC_ACK,
		]).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
	});

	it("encodes every server message byte-for-byte as the raw frame helpers do", () => {
		const users = [{ accountId: "1111 1111 1111 1111", color: "#000", connectedAt: 1 }];
		const cases: Array<[SyncMessage, ArrayBuffer]> = [
			[{ type: "sync", data: new Uint8Array([1, 2]) }, encodeWsFrame(WS_OP_SYNC, new Uint8Array([1, 2]))],
			[{ type: "sync-ack", outboxId: "delivery-1" }, encodeDurableSyncAck("delivery-1")],
			[{ type: "awareness", data: new Uint8Array([3]) }, encodeWsFrame(WS_OP_AWARENESS, new Uint8Array([3]))],
			[{ type: "presence", users }, encodeWsJsonFrame(WS_OP_PRESENCE, { users })],
			[{ type: "column-deleted" }, encodeWsFrame(WS_OP_COLUMN_DELETED)],
			[{ type: "access-revoked" }, encodeWsFrame(WS_OP_ACCESS_REVOKED)],
			[{ type: "error", message: "failed" }, encodeWsTextFrame(WS_OP_ERROR, "failed")],
		];
		for (const [message, rawFrame] of cases) {
			const frame = encodeServerMessage(message);
			expect(new Uint8Array(frame)).toEqual(new Uint8Array(rawFrame));
			expect(decodeWsMessage(frame)).toEqual(message);
		}
	});

	it("round-trips durable sync submissions and acknowledgements", () => {
		const update = new Uint8Array([1, 2, 3]);
		const submissionFrame = decodeWsFrame(
			encodeDurableSyncSubmission("delivery-1", update),
		);

		expect(submissionFrame.op).toBe(WS_OP_SYNC_SUBMIT);
		expect(decodeDurableSyncSubmission(submissionFrame.payload)).toEqual({
			outboxId: "delivery-1",
			update,
		});
		expect(decodeWsMessage(encodeDurableSyncAck("delivery-1"))).toEqual({
			type: "sync-ack",
			outboxId: "delivery-1",
		});
	});

	it("rejects malformed durable delivery envelopes", () => {
		expect(decodeDurableSyncSubmission(new Uint8Array())).toBeNull();
		expect(
			decodeDurableSyncSubmission(new Uint8Array([1, 2, 0x61])),
		).toBeNull();
		expect(decodeWsMessage(encodeWsFrame(WS_OP_SYNC_ACK))).toBeNull();
	});

	it("enforces delivery ID and opcode-specific payload limits", () => {
		expect(() =>
			encodeDurableSyncSubmission(
				"x".repeat(MAX_OUTBOX_ID_BYTES + 1),
				new Uint8Array([1]),
			),
		).toThrow(/delivery ID/i);
		expect(() =>
			encodeDurableSyncSubmission(
				"delivery",
				new Uint8Array(MAX_SYNC_UPDATE_BYTES + 1),
			),
		).toThrow(/size limit/i);

		const oversizedAwareness = new Uint8Array(2 + MAX_AWARENESS_BYTES);
		oversizedAwareness[0] = WS_OP_AWARENESS;
		expect(isWsFrameWithinLimits(oversizedAwareness.buffer)).toBe(false);
		expect(decodeWsMessage(oversizedAwareness.buffer)).toBeNull();
		expect(() =>
			encodeWsFrame(
				WS_OP_AWARENESS,
				new Uint8Array(MAX_AWARENESS_BYTES + 1),
			),
		).toThrow(/size limit/i);
	});

	it("round-trips binary frames", () => {
		const payload = new Uint8Array([0, 127, 255]);
		const decoded = decodeWsFrame(encodeWsFrame(WS_OP_SYNC, payload));

		expect(decoded.op).toBe(WS_OP_SYNC);
		expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
	});

	it("decodes sync, awareness, presence, lifecycle, and error messages", () => {
		const update = new Uint8Array([1, 2, 3]);
		const users = [
			{ accountId: "1234", color: "#fff", connectedAt: 42 },
		];

		expect(decodeWsMessage(encodeWsFrame(WS_OP_SYNC, update))).toEqual({
			type: "sync",
			data: update,
		});
		expect(decodeWsMessage(encodeWsFrame(WS_OP_AWARENESS, update))).toEqual({
			type: "awareness",
			data: update,
		});
		expect(
			decodeWsMessage(encodeWsJsonFrame(WS_OP_PRESENCE, { users })),
		).toEqual({ type: "presence", users });
		expect(decodeWsMessage(encodeWsFrame(WS_OP_COLUMN_DELETED))).toEqual({
			type: "column-deleted",
		});
		expect(decodeWsMessage(encodeWsFrame(WS_OP_ACCESS_REVOKED))).toEqual({
			type: "access-revoked",
		});
		expect(decodeWsMessage(encodeWsTextFrame(WS_OP_ERROR, "failed"))).toEqual({
			type: "error",
			message: "failed",
		});
	});

	it("rejects malformed presence and unknown opcodes", () => {
		expect(
			decodeWsMessage(encodeWsTextFrame(WS_OP_PRESENCE, "not-json")),
		).toBeNull();
		expect(decodeWsMessage(encodeWsFrame(0xff))).toBeNull();
	});
});
