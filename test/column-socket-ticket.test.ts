import { describe, expect, it } from "vitest";
import {
	ColumnSocketAuthorizationError,
	ColumnSocketProvisioningError,
} from "../src/lib/sync/column-session-machine";
import { fetchColumnSocketUrl } from "../src/lib/sync/column-socket-ticket";

const ACCOUNT_ID = "1111 1111 1111 1111";
const COLUMN_ID = "00000000-0000-4000-8000-000000000001";
const location = { protocol: "https:", host: "todo.example" };

function request(response: Response, hasPendingCreate: () => boolean = () => false) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return response;
	}) as typeof globalThis.fetch;
	return {
		calls,
		result: fetchColumnSocketUrl({ accountId: ACCOUNT_ID, columnId: COLUMN_ID, hasPendingCreate, fetch, location }),
	};
}

describe("column socket ticket", () => {
	it("exchanges a ticket for a secure socket URL", async () => {
		const { calls, result } = request(Response.json({ ticket: "a b" }));
		await expect(result).resolves.toBe(
			`wss://todo.example/api/column/${COLUMN_ID}/ws?ticket=a%20b`,
		);
		expect(calls).toMatchObject([
			{ url: `/api/column/${COLUMN_ID}/ws-ticket`, init: { method: "POST" } },
		]);
	});

	it("treats 403/404 as not provisioned while the column's create is queued", async () => {
		await expect(request(new Response(null, { status: 404 }), () => true).result)
			.rejects.toBeInstanceOf(ColumnSocketProvisioningError);
		await expect(request(new Response(null, { status: 403 })).result)
			.rejects.toBeInstanceOf(ColumnSocketAuthorizationError);
	});

	it("checks for a queued create only after the response arrives", async () => {
		let responded = false;
		const fetch = (async () => {
			responded = true;
			return new Response(null, { status: 404 });
		}) as typeof globalThis.fetch;
		const checkedAfterResponse: boolean[] = [];
		await expect(
			fetchColumnSocketUrl({
				accountId: ACCOUNT_ID,
				columnId: COLUMN_ID,
				hasPendingCreate: () => {
					checkedAfterResponse.push(responded);
					return false;
				},
				fetch,
				location,
			}),
		).rejects.toBeInstanceOf(ColumnSocketAuthorizationError);
		expect(checkedAfterResponse).toEqual([true]);
	});
});
