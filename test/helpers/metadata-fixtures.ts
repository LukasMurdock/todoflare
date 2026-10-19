// Fixtures shared by the metadata consistency and scheduled lifecycle tests:
// accounts and columns created through the Worker, and direct reads and
// writes of the account coordinator's records.
import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { normalizeAccountId } from "../../src/lib/account";
import type { Account } from "../../src/types/account";

export function headers(accountId: string): Record<string, string> {
	return {
		"X-Todoflare-Test-Account": normalizeAccountId(accountId),
		"Content-Type": "application/json",
	};
}

export async function createAccount(): Promise<Account> {
	const response = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
		headers: { "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 200)}.1` },
	});
	expect(response.ok).toBe(true);
	return ((await response.json()) as { account: Account }).account;
}

export async function createColumn(accountId: string, columnId = crypto.randomUUID()): Promise<string> {
	const response = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: headers(accountId),
		body: JSON.stringify({ columnId }),
	});
	expect(response.ok).toBe(true);
	return columnId;
}

export async function coordinatorRequest(
	accountId: string,
	path: "get" | "put" | "mutate",
	body: Record<string, unknown>,
): Promise<{ value?: string | null }> {
	const normalized = normalizeAccountId(accountId);
	const stub = env.ACCOUNT_COORDINATOR.get(
		env.ACCOUNT_COORDINATOR.idFromName(normalized),
	);
	const response = await stub.fetch(
		new Request(`http://account-coordinator/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	expect(response.ok).toBe(true);
	return (await response.json()) as { value?: string | null };
}

export async function loadAuthoritativeAccount(accountId: string): Promise<Account> {
	const key = `account:${normalizeAccountId(accountId)}`;
	const result = await coordinatorRequest(accountId, "get", { key });
	return JSON.parse(result.value as string) as Account;
}
