import { describe, expect, it } from "vitest";
import {
	decodeWsFrame,
	decodeWsMessage,
	encodeWsFrame,
	encodeWsJsonFrame,
	encodeWsTextFrame,
	WS_OP_ACCESS_REVOKED,
	WS_OP_AWARENESS,
	WS_OP_COLUMN_DELETED,
	WS_OP_ERROR,
	WS_OP_PRESENCE,
	WS_OP_SYNC,
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
		]).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
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
