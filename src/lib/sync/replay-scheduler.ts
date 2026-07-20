export const REPLAY_INTERVAL_MS = 5000;
export const E2E_REPLAY_WAKE_EVENT = "todoflare:e2e:replay-wake";

type ReplaySchedulerOptions = {
	intervalMs?: number;
	eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
	timers?: Pick<Window, "setInterval" | "clearInterval">;
	enableE2eWake?: boolean;
};

export function startReplayScheduler(
	replay: () => unknown | Promise<unknown>,
	options: ReplaySchedulerOptions = {},
): () => void {
	const timers = options.timers ?? window;
	const eventTarget = options.eventTarget ?? window;
	const intervalMs = options.intervalMs ?? REPLAY_INTERVAL_MS;
	let stopped = false;
	let replayInFlight: Promise<unknown> | null = null;
	let replayRequested = false;

	const wake = () => {
		if (stopped) return;
		if (replayInFlight) {
			replayRequested = true;
			return;
		}

		replayInFlight = Promise.resolve(replay()).finally(() => {
			replayInFlight = null;
			if (replayRequested) {
				replayRequested = false;
				wake();
			}
		});
	};

	wake();
	const timerId = timers.setInterval(wake, intervalMs);

	if (options.enableE2eWake) {
		eventTarget.addEventListener(E2E_REPLAY_WAKE_EVENT, wake);
	}

	return () => {
		stopped = true;
		timers.clearInterval(timerId);
		if (options.enableE2eWake) {
			eventTarget.removeEventListener(E2E_REPLAY_WAKE_EVENT, wake);
		}
	};
}
