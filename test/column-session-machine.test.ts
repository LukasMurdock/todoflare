import { createActor, SimulatedClock } from "xstate";
import { describe, expect, it } from "vitest";
import {
	columnSessionConnectionStatus,
	createColumnSessionMachine,
	type ColumnSessionDependencies,
} from "../src/lib/sync/column-session-machine";
import { ColumnSessionManager } from "../src/lib/sync/column-session-manager";
import type {
	ColumnSocketFrame,
	ColumnSocketLike,
} from "../src/lib/sync/column-socket-actor";

class FakeSocket implements ColumnSocketLike {
	binaryType = "";
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose:
		| ((event: { code?: number; reason?: string; wasClean?: boolean }) => void)
		| null = null;
	onerror: (() => void) | null = null;
	readonly sent: ArrayBuffer[] = [];
	closeCount = 0;
	readonly log: string[];

	constructor(log: string[]) {
		this.log = log;
	}

	open() {
		this.readyState = 1;
		this.onopen?.();
	}

	serverClose(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code, reason: "lost", wasClean: false });
	}

	send(data: ArrayBuffer) {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.log.push("socket.send");
		this.sent.push(data);
	}

	close() {
		this.log.push("socket.close");
		this.closeCount += 1;
		this.readyState = 3;
	}
}

function createHarness(options?: { replayFrames?: ColumnSocketFrame[] }) {
	const sockets: FakeSocket[] = [];
	const persisted: string[] = [];
	const written: ColumnSocketFrame[] = [];
	const log: string[] = [];
	let cleanupResolve: (() => void) | null = null;
	const cleanup = new Promise<void>((resolve) => {
		cleanupResolve = resolve;
	});

	const dependencies: ColumnSessionDependencies = {
		createSocket: () => {
			const socket = new FakeSocket(log);
			sockets.push(socket);
			return socket;
		},
		getSocketUrl: (_accountId, columnId) => `ws://test/${columnId}`,
		persistUpdate: (_accountId, _columnId, kind, update) => {
			log.push("outbox.persist");
			const id = `${kind}:${update[0] ?? 0}:${persisted.length}`;
			persisted.push(id);
			return id;
		},
		loadReplayFrames: () => options?.replayFrames ?? [],
		onFrameWritten: (frame) => {
			written.push(frame);
		},
		onMessage: () => {},
		onTerminate: async () => {
			log.push("cleanup.start");
			await cleanup;
			log.push("cleanup.done");
		},
		encodeUpdate: (_kind, update) => new Uint8Array(update).buffer,
	};

	const machine = createColumnSessionMachine(dependencies);
	const clock = new SimulatedClock();
	const actor = createActor(machine, {
		clock,
		input: {
			accountId: "account",
			columnId: "column",
			networkOnline: true,
			realtimeEnabled: true,
		},
	}).start();

	return {
		actor,
		clock,
		sockets,
		persisted,
		written,
		log,
		resolveCleanup: () => cleanupResolve?.(),
	};
}

describe("column session machine", () => {
	it("owns one socket and reaches connected only after ordered replay", () => {
		const replayFrames = [
			{ data: new Uint8Array([1]).buffer, outboxId: "first" },
			{ data: new Uint8Array([2]).buffer, outboxId: "second" },
		];
		const harness = createHarness({ replayFrames });

		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		expect(harness.sockets).toHaveLength(1);
		expect(columnSessionConnectionStatus(harness.actor.getSnapshot())).toBe(
			"connecting",
		);

		harness.sockets[0]!.open();

		expect(columnSessionConnectionStatus(harness.actor.getSnapshot())).toBe(
			"connected",
		);
		expect(harness.sockets[0]!.sent.map((frame) => [...new Uint8Array(frame)])).toEqual([
			[1],
			[2],
		]);
		expect(harness.written.map((frame) => frame.outboxId)).toEqual([
			"first",
			"second",
		]);
	});

	it("persists a live sync update before submitting it to the socket", () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		harness.sockets[0]!.open();

		harness.actor.send({ type: "SEND_SYNC", update: new Uint8Array([7]) });

		expect(harness.log.slice(-2)).toEqual(["outbox.persist", "socket.send"]);
		expect(harness.persisted).toHaveLength(1);
		expect(harness.written[0]?.outboxId).toBe(harness.persisted[0]);
	});

	it("makes duplicate leases and duplicate cleanup idempotent", () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		expect(harness.actor.getSnapshot().context.leases.size).toBe(1);

		harness.actor.send({ type: "UNSUBSCRIBE", leaseId: "editor" });
		harness.actor.send({ type: "UNSUBSCRIBE", leaseId: "editor" });

		expect(harness.actor.getSnapshot().matches("inactive")).toBe(true);
		expect(harness.sockets[0]!.closeCount).toBe(1);
	});

	it("cancels retry work when the final lease is released", () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		harness.sockets[0]!.serverClose();
		expect(harness.actor.getSnapshot().matches("reconnectDelay")).toBe(true);

		harness.actor.send({ type: "UNSUBSCRIBE", leaseId: "editor" });
		harness.clock.increment(60_000);

		expect(harness.actor.getSnapshot().matches("inactive")).toBe(true);
		expect(harness.sockets).toHaveLength(1);
	});

	it("ignores callbacks retained from a stopped socket actor", () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		const staleClose = harness.sockets[0]!.onclose;
		harness.actor.send({ type: "UNSUBSCRIBE", leaseId: "editor" });

		staleClose?.({ code: 1006, reason: "stale", wasClean: false });

		expect(harness.actor.getSnapshot().matches("inactive")).toBe(true);
		expect(harness.sockets).toHaveLength(1);
	});

	it("pauses offline without consuming retries and resumes when online", () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		harness.sockets[0]!.serverClose();
		expect(harness.actor.getSnapshot().context.retryAttempt).toBe(1);

		harness.actor.send({ type: "NETWORK_OFFLINE" });
		harness.clock.increment(60_000);
		expect(harness.actor.getSnapshot().matches("paused")).toBe(true);
		expect(harness.actor.getSnapshot().context.retryAttempt).toBe(1);
		expect(harness.sockets).toHaveLength(1);

		harness.actor.send({ type: "NETWORK_ONLINE" });
		expect(harness.sockets).toHaveLength(2);
		expect(harness.actor.getSnapshot().context.retryAttempt).toBe(1);
	});

	it("closes transport before terminal cleanup and rejects later work", async () => {
		const harness = createHarness();
		harness.actor.send({ type: "SUBSCRIBE", leaseId: "editor" });
		harness.sockets[0]!.open();

		harness.actor.send({ type: "ACCESS_REVOKED" });

		expect(harness.actor.getSnapshot().matches("terminating")).toBe(true);
		expect(harness.log.slice(-2)).toEqual(["socket.close", "cleanup.start"]);
		const completed = new Promise<void>((resolve) => {
			harness.actor.subscribe({ complete: resolve });
		});
		harness.resolveCleanup();
		await completed;
		expect(harness.actor.getSnapshot().status).toBe("done");

		harness.actor.send({ type: "SUBSCRIBE", leaseId: "late" });
		harness.actor.send({ type: "SEND_SYNC", update: new Uint8Array([9]) });
		expect(harness.sockets).toHaveLength(1);
		expect(harness.persisted).toHaveLength(0);
	});
});

describe("column session manager", () => {
	it("returns an idempotent lease cleanup closure", () => {
		const sockets: FakeSocket[] = [];
		const manager = new ColumnSessionManager({
			accountId: "account",
			networkOnline: true,
			realtimeEnabled: true,
			dependencies: {
				createSocket: () => {
					const socket = new FakeSocket([]);
					sockets.push(socket);
					return socket;
				},
				getSocketUrl: () => "ws://test/column",
				persistUpdate: () => undefined,
				loadReplayFrames: () => [],
				onFrameWritten: () => {},
				onMessage: () => {},
				onTerminate: async () => {},
				encodeUpdate: (_kind, update) => new Uint8Array(update).buffer,
			},
		});

		const unsubscribe = manager.subscribeToColumn("column");
		unsubscribe();
		unsubscribe();

		expect(sockets).toHaveLength(1);
		expect(sockets[0]!.closeCount).toBe(1);
		expect(manager.getOverallStatus()).toBe("offline");
		manager.stop();
	});

	it("keeps one column failure isolated from connected siblings", () => {
		const sockets = new Map<string, FakeSocket>();
		const manager = new ColumnSessionManager({
			accountId: "account",
			networkOnline: true,
			realtimeEnabled: true,
			dependencies: {
				createSocket: (url) => {
					const socket = new FakeSocket([]);
					sockets.set(url, socket);
					return socket;
				},
				getSocketUrl: (_accountId, columnId) => `ws://test/${columnId}`,
				persistUpdate: () => undefined,
				loadReplayFrames: () => [],
				onFrameWritten: () => {},
				onMessage: () => {},
				onTerminate: async () => {},
				encodeUpdate: (_kind, update) => new Uint8Array(update).buffer,
			},
		});

		manager.subscribeToColumn("a");
		manager.subscribeToColumn("b");
		sockets.get("ws://test/a")!.open();
		sockets.get("ws://test/b")!.open();
		expect(manager.getOverallStatus()).toBe("connected");

		sockets.get("ws://test/a")!.serverClose();

		expect(manager.getColumnStatus("a")).toBe("offline");
		expect(manager.getColumnStatus("b")).toBe("connected");
		expect(manager.getOverallStatus()).toBe("connected");
		expect(sockets.get("ws://test/b")!.closeCount).toBe(0);
		manager.stop();
	});
});
