import { describe, expect, it } from "vitest";
import { canApplyAccountHydration } from "../src/lib/sync/account-hydration";

const started = {
	accountId: "4829 1047 3856 2019",
	projectionRevision: 4,
	requestGeneration: 2,
};

describe("account hydration guard", () => {
	it("accepts an unchanged request for the same formatted account", () => {
		expect(
			canApplyAccountHydration(started, {
				...started,
				accountId: "4829104738562019",
			}),
		).toBe(true);
	});

	it("rejects a snapshot started before an optimistic command", () => {
		expect(
			canApplyAccountHydration(started, {
				...started,
				projectionRevision: 5,
			}),
		).toBe(false);
	});

	it("rejects an older request and a request for a previous account", () => {
		expect(
			canApplyAccountHydration(started, {
				...started,
				requestGeneration: 3,
			}),
		).toBe(false);
		expect(
			canApplyAccountHydration(started, {
				...started,
				accountId: "1111 2222 3333 4444",
			}),
		).toBe(false);
	});
});
