import { describe, expect, it } from "vitest";
import {
	hasColumnAccess,
	isColumnOwner,
	normalizeAccountIdSet,
} from "../src/lib/column-access";

const meta = {
	ownerId: "1111 2222 3333 4444",
	sharedWith: ["4829 1047 3856 2019"],
};

describe("column access", () => {
	it("treats formatted and normalized owner IDs identically", () => {
		expect(isColumnOwner(meta, "1111222233334444")).toBe(true);
	});

	it("treats formatted and normalized collaborator IDs identically", () => {
		expect(hasColumnAccess(meta, "4829104738562019")).toBe(true);
	});

	it("normalizes membership sets", () => {
		expect(normalizeAccountIdSet(meta.sharedWith).has("4829104738562019")).toBe(
			true,
		);
	});
});
