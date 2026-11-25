import { z } from "zod";
import type { APIRequestContext } from "@playwright/test";

function accountHeaders(accountId: string) {
	return { "X-Todoflare-Test-Account": accountId.replaceAll(/\D/g, "") };
}

export async function createAccount(
	request: APIRequestContext,
	baseURL: string,
): Promise<string> {
	const syntheticIp = `10.0.0.${Math.floor(Math.random() * 200) + 10}`;
	const response = await request.post(`${baseURL}/api/account`, {
		headers: {
			"X-Forwarded-For": syntheticIp,
		},
	});

	if (!response.ok()) {
		throw new Error(
			`Failed to create account (${response.status()}): ${await response.text()}`,
		);
	}

	const data = z.object({ account: z.object({ id: z.string() }) }).parse(await response.json());

	return data.account.id;
}

export async function createColumn(
	request: APIRequestContext,
	baseURL: string,
	accountId: string,
): Promise<string> {
	const response = await request.post(`${baseURL}/api/column`, {
		headers: { "Content-Type": "application/json", ...accountHeaders(accountId) },
		data: {},
	});
	if (!response.ok()) {
		throw new Error(
			`Failed to create column (${response.status()}): ${await response.text()}`,
		);
	}

	const payload = z.object({ column: z.object({ id: z.string() }) }).parse(await response.json());
	if (!payload.column?.id) {
		throw new Error("Failed to parse created column id");
	}

	return payload.column.id;
}

export async function getAccountColumnOrder(
	request: APIRequestContext,
	baseURL: string,
	accountId: string,
): Promise<Array<string>> {
	const response = await request.get(`${baseURL}/api/account`, {
		headers: accountHeaders(accountId),
	});

	if (!response.ok()) {
		throw new Error(
			`Failed to fetch account (${response.status()}): ${await response.text()}`,
		);
	}

	const payload = z.object({ account: z.object({ columnOrder: z.array(z.string()) }) }).parse(await response.json());

	return payload.account.columnOrder;
}
