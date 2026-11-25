import { describe, expect, it } from "vitest";
import { applyAccountRecordMutation, reorderColumnOrder } from "../src/server/account-record-store";

describe("reorderColumnOrder", () => {
	it("puts requested columns first and keeps the rest in order", () => {
		expect(reorderColumnOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
	});

	it("ignores unknown and repeated IDs", () => {
		expect(reorderColumnOrder(["a", "b"], ["x", "b", "b", "a", "b"])).toEqual(["b", "a"]);
	});

	it("repairs an order that was saved with duplicates", () => {
		expect(reorderColumnOrder(["a", "b", "a", "b"], ["b"])).toEqual(["b", "a"]);
	});
});

it("retains unrelated fields when reordering a pre-versioned account record", () => {
	const legacy = {
		id: "4829 1047 3856 2019",
		createdAt: 1234,
		columnOrder: ["a", "b", "a"],
		hiddenSharedColumns: ["c"],
	};
	const raw = applyAccountRecordMutation(JSON.stringify(legacy), { kind: "account-reorder", columnOrder: ["b"] });
	expect(JSON.parse(raw)).toEqual({ ...legacy, columnOrder: ["b", "a"] });
});
