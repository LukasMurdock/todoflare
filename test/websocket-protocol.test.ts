import { describe, expect, it } from "vitest";
import {
	decodeDurableSyncSubmission,
	decodeWsFrame,
	decodeWsMessage,
	encodeDurableSyncAck,
	encodeDurableSyncSubmission,
	encodeWsFrame,
	encodeWsJsonFrame,
	encodeWsTextFrame,
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
