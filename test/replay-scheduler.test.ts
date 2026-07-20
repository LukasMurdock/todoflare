import { describe, expect, it, vi } from "vitest";
import {
	E2E_REPLAY_WAKE_EVENT,
	startReplayScheduler,
} from "../src/lib/sync/replay-scheduler";

function createTimerHarness() {
	let intervalCallback: (() => void) | null = null;
	const clearInterval = vi.fn();

	return {
		timers: {
			setInterval(callback: TimerHandler) {
				intervalCallback = callback as () => void;
				return 1;
			},
			clearInterval,
		} as Pick<Window, "setInterval" | "clearInterval">,
		clearInterval,
		runInterval: () => intervalCallback?.(),
	};
}

describe("replay scheduler", () => {
	it("runs immediately, on the production interval, and cleans up", async () => {
		const harness = createTimerHarness();
		const replay = vi.fn(async () => undefined);
		const stop = startReplayScheduler(replay, {
			eventTarget: new EventTarget(),
			timers: harness.timers,
		});

		expect(replay).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		harness.runInterval();
		expect(replay).toHaveBeenCalledTimes(2);

		stop();
		expect(harness.clearInterval).toHaveBeenCalledWith(1);
	});

	it("coalesces an E2E wake received during an active replay", async () => {
		const harness = createTimerHarness();
		const eventTarget = new EventTarget();
		let finishReplay: (() => void) | undefined;
		const replay = vi.fn(
			() => new Promise<void>((resolve) => {
				finishReplay = resolve;
			}),
		);
		const stop = startReplayScheduler(replay, {
			enableE2eWake: true,
			eventTarget,
			timers: harness.timers,
		});

		eventTarget.dispatchEvent(new Event(E2E_REPLAY_WAKE_EVENT));
		expect(replay).toHaveBeenCalledTimes(1);

		finishReplay?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(replay).toHaveBeenCalledTimes(2);

		stop();
		finishReplay?.();
	});
});
