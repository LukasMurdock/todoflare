import { describe, expect, it } from "vitest";
import {
	flushBufferedColumnMessages,
	queueOrSendColumnMessage,
	type BufferedColumnConnection,
	type BufferedColumnSend,
	type FlushableColumnConnection,
} from "../src/lib/sync/column-send-buffer";

function encodeMessage(message: BufferedColumnSend): ArrayBuffer {
	const copy = new Uint8Array(message.payload.byteLength);
	copy.set(message.payload);
	return copy.buffer;
}

describe("queueOrSendColumnMessage", () => {
	it("buffers sync messages when websocket is not created yet", () => {
		const connection: BufferedColumnConnection = {
			ws: null,
			pendingSends: [],
		};

		const message: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([1, 2, 3]),
		};

		queueOrSendColumnMessage(connection, message, encodeMessage);

		expect(connection.pendingSends).toHaveLength(1);
		expect(connection.pendingSends[0]).toEqual(message);
	});

	it("buffers awareness messages while websocket is connecting", () => {
		const sent: ArrayBuffer[] = [];
		const connection: BufferedColumnConnection = {
			ws: {
				readyState: 0,
				send(data: ArrayBuffer) {
					sent.push(data);
				},
			},
			pendingSends: [],
		};

		const message: BufferedColumnSend = {
			kind: "awareness",
			payload: new Uint8Array([9, 9]),
		};

		queueOrSendColumnMessage(connection, message, encodeMessage);

		expect(sent).toHaveLength(0);
		expect(connection.pendingSends).toEqual([message]);
	});

	it("sends immediately when websocket is open", () => {
		const sent: ArrayBuffer[] = [];
		const sentKinds: Array<BufferedColumnSend["kind"]> = [];
		const connection: BufferedColumnConnection = {
			ws: {
				readyState: 1,
				send(data: ArrayBuffer) {
					sent.push(data);
				},
			},
			pendingSends: [],
		};

		const message: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([4, 5, 6]),
		};

		queueOrSendColumnMessage(connection, message, encodeMessage, {
			onSent: (sentMessage) => {
				sentKinds.push(sentMessage.kind);
			},
		});

		expect(sent).toHaveLength(1);
		expect(sentKinds).toEqual(["sync"]);
		expect(new Uint8Array(sent[0] as ArrayBuffer)).toEqual(
			new Uint8Array([4, 5, 6]),
		);
		expect(connection.pendingSends).toHaveLength(0);
	});

	it("queues when websocket send throws", () => {
		const connection: BufferedColumnConnection = {
			ws: {
				readyState: 1,
				send() {
					throw new Error("broken socket");
				},
			},
			pendingSends: [],
		};

		const message: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([4, 5, 6]),
		};

		queueOrSendColumnMessage(connection, message, encodeMessage);

		expect(connection.pendingSends).toEqual([message]);
	});

	it("drops oldest message when cap is exceeded with default policy", () => {
		const droppedKinds: Array<BufferedColumnSend["kind"]> = [];
		const connection: BufferedColumnConnection = {
			ws: null,
			pendingSends: [
				{ kind: "sync", payload: new Uint8Array([1]) },
				{ kind: "awareness", payload: new Uint8Array([2]) },
			],
		};

		queueOrSendColumnMessage(
			connection,
			{ kind: "sync", payload: new Uint8Array([3]) },
			encodeMessage,
			{
				maxPendingMessages: 2,
				onDrop: ({ droppedMessage }) => {
					droppedKinds.push(droppedMessage.kind);
				},
			},
		);

		expect(droppedKinds).toEqual(["sync"]);
		expect(connection.pendingSends).toEqual([
			{ kind: "awareness", payload: new Uint8Array([2]) },
			{ kind: "sync", payload: new Uint8Array([3]) },
		]);
	});

	it("drops awareness first when configured", () => {
		const connection: BufferedColumnConnection = {
			ws: null,
			pendingSends: [
				{ kind: "sync", payload: new Uint8Array([1]) },
				{ kind: "awareness", payload: new Uint8Array([2]) },
			],
		};

		queueOrSendColumnMessage(
			connection,
			{ kind: "sync", payload: new Uint8Array([3]) },
			encodeMessage,
			{
				maxPendingMessages: 2,
				dropPolicy: "drop_awareness_first",
			},
		);

		expect(connection.pendingSends).toEqual([
			{ kind: "sync", payload: new Uint8Array([1]) },
			{ kind: "sync", payload: new Uint8Array([3]) },
		]);
	});
});

describe("flushBufferedColumnMessages", () => {
	it("drains buffered messages in order when connected", () => {
		const sent: number[][] = [];
		const connection: FlushableColumnConnection = {
			status: "connected",
			ws: {
				readyState: 1,
				send(data: ArrayBuffer) {
					sent.push(Array.from(new Uint8Array(data)));
				},
			},
			pendingSends: [
				{ kind: "sync", payload: new Uint8Array([1]) },
				{ kind: "awareness", payload: new Uint8Array([2]) },
			],
		};

		const sentCount = flushBufferedColumnMessages(connection, encodeMessage);

		expect(sentCount).toBe(2);
		expect(sent).toEqual([[1], [2]]);
		expect(connection.pendingSends).toHaveLength(0);
	});

	it("keeps buffer untouched when not connected", () => {
		const sent: ArrayBuffer[] = [];
		const message: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([7]),
		};
		const connection: FlushableColumnConnection = {
			status: "offline",
			ws: {
				readyState: 1,
				send(data: ArrayBuffer) {
					sent.push(data);
				},
			},
			pendingSends: [message],
		};

		const sentCount = flushBufferedColumnMessages(connection, encodeMessage);

		expect(sentCount).toBe(0);
		expect(sent).toHaveLength(0);
		expect(connection.pendingSends).toEqual([message]);
	});

	it("keeps failed messages buffered", () => {
		const sent: number[][] = [];
		let sendCallCount = 0;
		const first: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([1]),
		};
		const second: BufferedColumnSend = {
			kind: "sync",
			payload: new Uint8Array([2]),
		};
		const third: BufferedColumnSend = {
			kind: "awareness",
			payload: new Uint8Array([3]),
		};
		const connection: FlushableColumnConnection = {
			status: "connected",
			ws: {
				readyState: 1,
				send(data: ArrayBuffer) {
					sendCallCount += 1;
					if (sendCallCount === 2) {
						throw new Error("send failed");
					}
					sent.push(Array.from(new Uint8Array(data)));
				},
			},
			pendingSends: [first, second, third],
		};

		const sentCount = flushBufferedColumnMessages(connection, encodeMessage);

		expect(sentCount).toBe(2);
		expect(sent).toEqual([[1], [3]]);
		expect(connection.pendingSends).toEqual([second]);
	});
});
