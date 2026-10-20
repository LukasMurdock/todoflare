import { describe, expect, it } from "vitest";
import { reorderColumnOrder } from "../src/server/account-record-store";

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
