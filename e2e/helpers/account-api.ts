import type { APIRequestContext } from "@playwright/test";

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

	const data = (await response.json()) as {
		account: { id: string };
	};

	return data.account.id;
}

export async function createColumn(
	request: APIRequestContext,
	baseURL: string,
	accountId: string,
): Promise<string> {
	const response = await request.post(`${baseURL}/api/column`, {
		headers: { "Content-Type": "application/json" },
		data: { accountId },
	});
	if (!response.ok()) {
		throw new Error(
			`Failed to create column (${response.status()}): ${await response.text()}`,
		);
	}

	const payload = (await response.json()) as { column?: { id?: string } };
	if (!payload.column?.id) {
		throw new Error("Failed to parse created column id");
	}

	return payload.column.id;
}

export async function getAccountColumnOrder(
	request: APIRequestContext,
	baseURL: string,
	accountId: string,
): Promise<string[]> {
	const response = await request.get(
		`${baseURL}/api/account/${accountId.replace(/\D/g, "")}`,
	);

	if (!response.ok()) {
		throw new Error(
			`Failed to fetch account (${response.status()}): ${await response.text()}`,
		);
	}

	const payload = (await response.json()) as {
		account?: { columnOrder?: unknown };
	};

	if (!payload.account || !Array.isArray(payload.account.columnOrder)) {
		throw new Error("Failed to parse account column order");
	}

	return payload.account.columnOrder.filter(
		(columnId): columnId is string => typeof columnId === "string",
	);
}
