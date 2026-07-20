import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/server/bounded-concurrency";

describe("mapWithConcurrency", () => {
	it("limits active work and preserves input order", async () => {
		let active = 0;
		let maximumActive = 0;
		const results = await mapWithConcurrency([5, 4, 3, 2, 1, 0], 3, async (value) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, value));
			active -= 1;
			return value * 2;
		});

		expect(maximumActive).toBe(3);
		expect(results).toEqual([10, 8, 6, 4, 2, 0]);
	});

	it("rejects invalid limits", async () => {
		await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
			"positive integer",
		);
	});
});
