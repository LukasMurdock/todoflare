import { describe, expect, it } from "vitest";
import { classifyYjsOutbox, ORPHANED_YJS_GRACE_MS } from "../src/lib/sync/yjs-outbox-retention";
import type { YjsOutboxEntry } from "../src/lib/sync/yjs-update-outbox";

const NOW = 10_000_000;

function entry(id: string, columnId: string, kind: "sync" | "awareness", ageMs = 0): YjsOutboxEntry {
	return {
		id,
		accountId: "1111111111111111",
		columnId,
		kind,
		updateBytes: [1],
		stateVectorBytes: null,
		createdAt: NOW - ageMs,
		attemptCount: 0,
		nextRetryAt: NOW,
		ackedAt: null,
		terminalReason: null,
		lastError: null,
	};
}

function classify(entries: YjsOutboxEntry[]) {
	const result = classifyYjsOutbox(entries, {
		activeColumnIds: new Set(["active"]),
		trashedColumnIds: new Set(["trashed"]),
		now: NOW,
		awarenessMaxAgeMs: 30_000,
	});
	return {
		sendable: result.sendable.map((e) => e.id),
		heldForTrash: result.heldForTrash.map((e) => e.id),
		discardable: result.discardable.map((e) => e.id),
	};
}

describe("classifyYjsOutbox", () => {
	it("keeps edits for active columns and drops only stale presence", () => {
		expect(classify([
			entry("edit", "active", "sync", 60 * 60 * 1000),
			entry("fresh-presence", "active", "awareness", 1_000),
			entry("stale-presence", "active", "awareness", 60_000),
		])).toEqual({ sendable: ["edit", "fresh-presence"], heldForTrash: [], discardable: ["stale-presence"] });
	});

	it("holds edits for trashed columns so a restore can send them", () => {
		expect(classify([
			entry("edit", "trashed", "sync", 7 * 24 * 60 * 60 * 1000),
			entry("presence", "trashed", "awareness"),
		])).toEqual({ sendable: [], heldForTrash: ["edit"], discardable: ["presence"] });
	});

	it("drops edits for a column the account no longer has, after a grace period", () => {
		expect(classify([
			entry("recent", "gone", "sync", ORPHANED_YJS_GRACE_MS - 1),
			entry("old", "gone", "sync", ORPHANED_YJS_GRACE_MS + 1),
			entry("presence", "gone", "awareness"),
		])).toEqual({ sendable: ["recent"], heldForTrash: [], discardable: ["old", "presence"] });
	});
});
