import { describe, expect, it } from "vitest";
import {
	removeSharedWithByColumn,
	upsertSharedWithByColumn,
	type SharedWithByColumn,
} from "../src/lib/sync/replay-state";

describe("replay sharedWith state", () => {
	it("updates sharedWith for queued share replay ack", () => {
		const state: SharedWithByColumn = {
			"col-1": ["1111 1111 1111 1111"],
		};

		const next = upsertSharedWithByColumn(state, "col-1", [
			"1111 1111 1111 1111",
			"2222 2222 2222 2222",
		]);

		expect(next).toEqual({
			"col-1": ["1111 1111 1111 1111", "2222 2222 2222 2222"],
		});
		expect(next).not.toBe(state);
	});

	it("keeps reference when replay ack has unchanged sharedWith", () => {
		const state: SharedWithByColumn = {
			"col-1": ["1111 1111 1111 1111", "2222 2222 2222 2222"],
		};

		const next = upsertSharedWithByColumn(state, "col-1", [
			"1111 1111 1111 1111",
			"2222 2222 2222 2222",
		]);

		expect(next).toBe(state);
	});

	it("removes sharedWith for queued revoke/delete replay cleanup", () => {
		const state: SharedWithByColumn = {
			"col-1": ["1111 1111 1111 1111"],
			"col-2": ["3333 3333 3333 3333"],
		};

		const next = removeSharedWithByColumn(state, "col-1");

		expect(next).toEqual({
			"col-2": ["3333 3333 3333 3333"],
		});
		expect(next).not.toBe(state);
	});

	it("keeps reference when removing unknown column", () => {
		const state: SharedWithByColumn = {
			"col-1": ["1111 1111 1111 1111"],
		};

		const next = removeSharedWithByColumn(state, "col-3");

		expect(next).toBe(state);
	});
});
