import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

/** Abruptly discards a room's in-memory state while preserving its committed SQLite data. */
export async function restartColumnRoom(columnId: string) {
	const id = env.COLUMN_ROOM.idFromName(columnId);
	const room = env.COLUMN_ROOM.get(id);
	await expect(runInDurableObject(room, (_instance, state) => {
		state.abort("Injected column room crash");
	})).rejects.toThrow("Injected column room crash");
	return env.COLUMN_ROOM.get(id);
}
