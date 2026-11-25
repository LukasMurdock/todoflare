import { z } from "zod";
import { parseDeletedColumnRecords } from "./persistence-records";

/**
 * Applies a requested order to the account's columns: known requested IDs
 * first, then the rest in their current order. Unknown IDs are ignored and
 * each column appears once, which also repairs an order saved with duplicates.
 */
export function reorderColumnOrder(current: ReadonlyArray<string>, requested: ReadonlyArray<string>): Array<string> {
	const known = new Set(current);
	return Array.from(new Set([...requested.filter((id) => known.has(id)), ...current]));
}

export interface AccountRecordStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

interface AccountRecordStoreBindings<TAccountCoordinatorId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete?(key: string): Promise<void>;
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TAccountCoordinatorId;
		get(id: TAccountCoordinatorId): { fetch(request: Request): Promise<Response> };
	};
}

export type AccountRecordMutation =
	| { kind: "account-add-column"; columnId: string; maxColumns?: number }
	| { kind: "account-remove-column"; columnId: string }
	| { kind: "account-reorder"; columnOrder: Array<string> }
	| { kind: "account-set-hidden"; hiddenSharedColumns: Array<string> }
	| { kind: "shared-add"; columnId: string }
	| { kind: "shared-remove"; columnId: string }
	| { kind: "trash-upsert"; columnId: string; deletedAt: number; retentionMs: number }
	| { kind: "trash-remove"; columnId: string };

function accountIdFromKey(key: string): string | null {
	const match = /^(?:account|shared|trash):([0-9]+)$/.exec(key);
	return match?.[1] ?? null;
}

export function accountRecordStore<TAccountCoordinatorId>(
	env: AccountRecordStoreBindings<TAccountCoordinatorId>,
): AccountRecordStore {
	const coordinator = env.ACCOUNT_COORDINATOR;
	if (!coordinator) {
		return {
			get: (key) => env.ACCOUNTS.get(key),
			put: (key, value) => env.ACCOUNTS.put(key, value),
			delete: async (key) => {
				if (!env.ACCOUNTS.delete) {throw new Error("Record store does not support delete");}
				await env.ACCOUNTS.delete(key);
			},
		};
	}
	const boundCoordinator = coordinator;

	async function request(
		path: "get" | "put" | "delete",
		key: string,
		value?: string,
	): Promise<{ value?: string | null }> {
		const accountId = accountIdFromKey(key);
		if (!accountId) {
			if (path === "get") {return { value: await env.ACCOUNTS.get(key) };}
			if (path === "put") {
				if (value === undefined) {throw new Error("Missing record value");}
				await env.ACCOUNTS.put(key, value);
			}
			else {
				if (!env.ACCOUNTS.delete) {throw new Error("Record store does not support delete");}
				await env.ACCOUNTS.delete(key);
			}
			return {};
		}

		const stub = boundCoordinator.get(boundCoordinator.idFromName(accountId));
		const response = await stub.fetch(
			new Request(`http://account-coordinator/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key, value }),
			}),
		);
		if (!response.ok) {
			throw new Error(`Account coordinator ${path} failed: ${response.status}`);
		}
		return await response.json<{ value?: string | null }>();
	}

	return {
		get: async (key) => (await request("get", key)).value ?? null,
		put: async (key, value) => {
			await request("put", key, value);
		},
		delete: async (key) => {
			await request("delete", key);
		},
	};
}

export async function mutateAccountRecord<TAccountCoordinatorId>(
	env: AccountRecordStoreBindings<TAccountCoordinatorId>,
	key: string,
	mutation: AccountRecordMutation,
): Promise<string> {
	const coordinator = env.ACCOUNT_COORDINATOR;
	const accountId = accountIdFromKey(key);
	if (coordinator && accountId) {
		const stub = coordinator.get(coordinator.idFromName(accountId));
		const response = await stub.fetch(
			new Request("http://account-coordinator/mutate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key, mutation }),
			}),
		);
		if (!response.ok) {
			const body = await response.json<{ error?: string }>().catch(() => null);
			throw new Error(body?.error ?? `Account mutation failed: ${response.status}`);
		}
		return (await response.json<{ value: string }>()).value;
	}

	const store = accountRecordStore(env);
	const value = applyAccountRecordMutation(await store.get(key), mutation);
	await store.put(key, value);
	return value;
}

// Account commands change individual fields. Retain other fields verbatim,
// including accounts saved before schemaVersion existed.
const columnIdsSchema = z.array(z.string());
const mutableAccountSchema = z.looseObject({
	columnOrder: columnIdsSchema,
	hiddenSharedColumns: columnIdsSchema.optional(),
});

export function applyAccountRecordMutation(value: string | null, mutation: AccountRecordMutation): string {
	switch (mutation.kind) {
	case "account-add-column":
	case "account-remove-column":
	case "account-reorder":
	case "account-set-hidden": {
		if (value === null) {throw new Error("Account not found");}
		const account = mutableAccountSchema.parse(JSON.parse(value));
		if (mutation.kind === "account-add-column") {
			if (!account.columnOrder.includes(mutation.columnId)) {
				if (account.columnOrder.length >= (mutation.maxColumns ?? 100)) {
					throw new Error("Column limit reached");
				}
				account.columnOrder.push(mutation.columnId);
			}
		} else if (mutation.kind === "account-remove-column") {
			account.columnOrder = account.columnOrder.filter(
				(columnId) => columnId !== mutation.columnId,
			);
		} else if (mutation.kind === "account-reorder") {
			account.columnOrder = reorderColumnOrder(account.columnOrder, mutation.columnOrder);
		} else {
			account.hiddenSharedColumns = mutation.hiddenSharedColumns;
		}
		return JSON.stringify(account);
	}
	case "shared-add":
	case "shared-remove": {
		const columns = value === null ? [] : columnIdsSchema.parse(JSON.parse(value));
		const next =
			mutation.kind === "shared-add"
				? Array.from(new Set([...columns, mutation.columnId]))
				: columns.filter((columnId) => columnId !== mutation.columnId);
		return JSON.stringify(next);
	}
	case "trash-upsert":
	case "trash-remove": {
		const parsedTrash = parseDeletedColumnRecords(value);
		if (!parsedTrash.ok) {throw new Error(`Trash record ${parsedTrash.code}`);}
		const trash = parsedTrash.value;
		if (mutation.kind === "trash-remove") {
			return JSON.stringify(trash.filter((entry) => entry.columnId !== mutation.columnId));
		}
		const retained = trash.filter(
			(entry) =>
				mutation.deletedAt - entry.deletedAt < mutation.retentionMs &&
				entry.columnId !== mutation.columnId,
		);
		return JSON.stringify([
			{ columnId: mutation.columnId, deletedAt: mutation.deletedAt },
			...retained,
		]);
	}
	}
}
