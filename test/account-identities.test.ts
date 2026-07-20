import { describe, expect, it } from "vitest";
import {
	allocateGeneratedId,
	generateAccountId,
	generatePublicId,
} from "../src/lib/account";

function queuedRandomValues(
	values: number[],
): (bytes: Uint8Array<ArrayBuffer>) => void {
	let offset = 0;
	return (bytes) => {
		for (let index = 0; index < bytes.length; index++) {
			if (offset >= values.length) throw new Error("Random byte fixture exhausted");
			bytes[index] = values[offset++];
		}
	};
}

describe("generated identities", () => {
	it("generates account IDs in the existing display format", () => {
		const accountId = generateAccountId();
		expect(accountId).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
	});

	it("generates public IDs using only the base62 alphabet", () => {
		const publicId = generatePublicId();
		expect(publicId).toMatch(/^[0-9A-Za-z]{8}$/);
	});

	it("rejects random bytes that would introduce modulo bias", () => {
		const accountId = generateAccountId(
			queuedRandomValues([
				250, 251, 252, 253, 254, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
				10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
			]),
		);
		expect(accountId).toBe("0123 4567 8901 2345");
	});

	it("retries injected collisions and returns the first unused ID", async () => {
		const candidates = ["collision-one", "collision-two", "available"];
		const checked: string[] = [];

		await expect(
			allocateGeneratedId({
				createId: () => candidates.shift() as string,
				isInUse: async (id) => {
					checked.push(id);
					return id !== "available";
				},
				maxAttempts: 3,
			}),
		).resolves.toBe("available");
		expect(checked).toEqual(["collision-one", "collision-two", "available"]);
	});

	it("stops after the configured collision limit", async () => {
		let generated = 0;
		await expect(
			allocateGeneratedId({
				createId: () => `collision-${++generated}`,
				isInUse: async () => true,
				maxAttempts: 2,
			}),
		).rejects.toThrow("Unable to allocate a unique ID after 2 attempts");
		expect(generated).toBe(2);
	});
});
