import { normalizeAccountId } from "../../lib/account";
import type { ColumnMeta } from "../../types/account";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import { claimPublicId } from "../public-id-registry";
import { releasePublicId } from "../public-id-registry";
import type { LifecycleOperation } from "../lifecycle-journal";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
} from "../persistence-records";
import { deleteColumn } from "./delete-column";
import { disablePublicColumn } from "./disable-public-column";
import { enablePublicColumn } from "./enable-public-column";
import { restoreColumn } from "./restore-column";
import { revokeColumnShare } from "./revoke-column-share";
import { shareColumn } from "./share-column";

interface KeyPage {
	keys: Array<{ name: string }>;
	list_complete: boolean;
	cursor?: string;
}

export interface ReconcileLifecycleBindings<TDurableObjectId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
		list(options: {
			prefix: string;
			cursor?: string;
			limit: number;
		}): Promise<KeyPage>;
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TDurableObjectId;
		get(id: TDurableObjectId): { fetch(request: Request): Promise<Response> };
	};
	PUBLIC_ID_COORDINATOR?: {
		idFromName(name: string): TDurableObjectId;
		get(id: TDurableObjectId): { fetch(request: Request): Promise<Response> };
	};
	COLUMN_ROOM: {
		idFromName(name: string): TDurableObjectId;
		get(id: TDurableObjectId): { fetch(request: Request): Promise<Response> };
	};
}

export interface ReconcileLifecycleResult {
	registryScanned: number;
	operationsRetried: number;
	operationsCompleted: number;
	operationsFailed: number;
	columnsInitialized: number;
	ownerMembershipRepaired: number;
	ownerMembershipRemoved: number;
	sharedMembershipRepaired: number;
	sharedMembershipRemoved: number;
	publicMappingsRepaired: number;
	publicMappingsRemoved: number;
	publicMappingConflicts: number;
	invalidRecords: number;
}

async function listAll<TDurableObjectId>(
	env: ReconcileLifecycleBindings<TDurableObjectId>,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const page = await env.ACCOUNTS.list({ prefix, cursor, limit: 1000 });
		keys.push(...page.keys.map((key) => key.name));
		if (page.list_complete) return keys;
		cursor = page.cursor;
	}
}

async function retryOperation<TDurableObjectId>(
	env: ReconcileLifecycleBindings<TDurableObjectId>,
	operation: LifecycleOperation,
): Promise<boolean> {
	if (operation.kind === "create") {
		const { meta } = operation;
		await env.ACCOUNTS.put(`column-registry:${meta.id}`, JSON.stringify(meta));
		await mutateAccountRecord(env, `account:${normalizeAccountId(meta.ownerId)}`, {
			kind: "account-add-column",
			columnId: meta.id,
		});
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(meta.id));
		const response = await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(meta),
			}),
		);
		return response.ok;
	}

	const common = {
		env,
		columnId: operation.columnId,
		accountId: operation.accountId,
	};
	let result;
	if (operation.kind === "delete") result = await deleteColumn(common);
	else if (operation.kind === "restore") result = await restoreColumn(common);
	else if (operation.kind === "enable-public") result = await enablePublicColumn(common);
	else if (operation.kind === "disable-public") result = await disablePublicColumn(common);
	else if (operation.kind === "share") {
		result = await shareColumn({
			...common,
			targetAccountId: operation.targetAccountId,
		});
	} else if (operation.kind === "revoke" && "targetAccountId" in operation) {
		result = await revokeColumnShare({
			...common,
			targetAccountId: operation.targetAccountId,
		});
	} else {
		return false;
	}
	return result.ok;
}

export async function reconcileColumnLifecycle<TDurableObjectId>(
	env: ReconcileLifecycleBindings<TDurableObjectId>,
): Promise<ReconcileLifecycleResult> {
	const result: ReconcileLifecycleResult = {
		registryScanned: 0,
		operationsRetried: 0,
		operationsCompleted: 0,
		operationsFailed: 0,
		columnsInitialized: 0,
		ownerMembershipRepaired: 0,
		ownerMembershipRemoved: 0,
		sharedMembershipRepaired: 0,
		sharedMembershipRemoved: 0,
		publicMappingsRepaired: 0,
		publicMappingsRemoved: 0,
		publicMappingConflicts: 0,
		invalidRecords: 0,
	};

	for (const key of await listAll(env, "lifecycle-operation:")) {
		const raw = await env.ACCOUNTS.get(key);
		if (!raw) continue;
		result.operationsRetried += 1;
		try {
			const operation = JSON.parse(raw) as LifecycleOperation;
			if (!operation.operationId || !operation.kind) throw new Error("invalid operation");
			if (await retryOperation(env, operation)) {
				await env.ACCOUNTS.delete(key);
				result.operationsCompleted += 1;
			} else {
				result.operationsFailed += 1;
			}
		} catch {
			result.operationsFailed += 1;
		}
	}

	const records = accountRecordStore(env);
	for (const key of await listAll(env, "column-registry:")) {
		const raw = await env.ACCOUNTS.get(key);
		if (!raw) continue;
		let registryValue: unknown;
		try {
			registryValue = JSON.parse(raw) as unknown;
		} catch {
			result.invalidRecords += 1;
			continue;
		}
		const parsedRegistry = parseColumnMetaRecord(registryValue);
		if (!parsedRegistry.ok) {
			result.invalidRecords += 1;
			continue;
		}
		result.registryScanned += 1;
		let meta: ColumnMeta = parsedRegistry.value;
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(meta.id));
		let metaResponse = await stub.fetch(new Request("http://do/meta"));
		if (metaResponse.status === 404) {
			const initResponse = await stub.fetch(
				new Request("http://do/init", { method: "POST", body: JSON.stringify(meta) }),
			);
			if (!initResponse.ok) continue;
			result.columnsInitialized += 1;
			metaResponse = await stub.fetch(new Request("http://do/meta"));
		}
		if (!metaResponse.ok) continue;
		const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
		if (!parsedMeta.ok) {
			result.invalidRecords += 1;
			continue;
		}
		meta = parsedMeta.value;

		const ownerId = normalizeAccountId(meta.ownerId);
		const ownerKey = `account:${ownerId}`;
		const ownerRaw = await records.get(ownerKey);
		const trash = parseDeletedColumnRecords(await records.get(`trash:${ownerId}`));
		const isTrashed = trash.some((entry) => entry.columnId === meta.id);
		if (ownerRaw && !isTrashed) {
			const owner = parseAccountRecord(ownerRaw);
			if (owner.ok && !owner.value.columnOrder.includes(meta.id)) {
				await mutateAccountRecord(env, ownerKey, {
					kind: "account-add-column",
					columnId: meta.id,
				});
				result.ownerMembershipRepaired += 1;
			}
		}

		for (const sharedAccountId of meta.sharedWith) {
			const sharedKey = `shared:${normalizeAccountId(sharedAccountId)}`;
			const shared = parseSharedColumnIndex(await records.get(sharedKey));
			if (shared.ok && !shared.value.includes(meta.id)) {
				await mutateAccountRecord(env, sharedKey, {
					kind: "shared-add",
					columnId: meta.id,
				});
				result.sharedMembershipRepaired += 1;
			}
		}

		if (meta.publicId) {
			const mapped = await env.ACCOUNTS.get(`public:${meta.publicId}`);
			if (mapped === null && (await claimPublicId(env, meta.publicId, meta.id))) {
				result.publicMappingsRepaired += 1;
			} else if (mapped !== null && mapped !== meta.id) {
				result.publicMappingConflicts += 1;
			}
		}
	}

	for (const accountKey of await listAll(env, "account:")) {
		const accountId = accountKey.slice("account:".length);
		const accountRaw = await records.get(accountKey);
		if (!accountRaw) continue;
		const account = parseAccountRecord(accountRaw);
		if (!account.ok) {
			result.invalidRecords += 1;
			continue;
		}
		for (const columnId of account.value.columnOrder) {
			const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
			const response = await stub.fetch(new Request("http://do/meta"));
			let shouldRemove = response.status === 404;
			if (response.ok) {
				const meta = parseColumnMetaRecord(await response.json());
				if (!meta.ok) {
					result.invalidRecords += 1;
					continue;
				}
				shouldRemove = normalizeAccountId(meta.value.ownerId) !== accountId;
			} else if (response.status !== 404) {
				continue;
			}
			if (!shouldRemove) continue;
			await mutateAccountRecord(env, accountKey, {
				kind: "account-remove-column",
				columnId,
			});
			result.ownerMembershipRemoved += 1;
		}

		const sharedKey = `shared:${accountId}`;
		const shared = parseSharedColumnIndex(await records.get(sharedKey));
		if (!shared.ok) {
			result.invalidRecords += 1;
			continue;
		}
		for (const columnId of shared.value) {
			const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
			const response = await stub.fetch(new Request("http://do/meta"));
			let stillShared = false;
			if (response.ok) {
				const meta = parseColumnMetaRecord(await response.json());
				stillShared =
					meta.ok &&
					meta.value.sharedWith.some(
						(sharedAccountId) => normalizeAccountId(sharedAccountId) === accountId,
					);
			} else if (response.status !== 404) continue;
			if (!stillShared) {
				await mutateAccountRecord(env, sharedKey, {
					kind: "shared-remove",
					columnId,
				});
				result.sharedMembershipRemoved += 1;
			}
		}
	}

	for (const publicKey of await listAll(env, "public:")) {
		const publicId = publicKey.slice("public:".length);
		const columnId = await env.ACCOUNTS.get(publicKey);
		if (!columnId) continue;
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const response = await stub.fetch(new Request("http://do/meta"));
		let matches = false;
		if (response.ok) {
			const meta = parseColumnMetaRecord(await response.json());
			matches = meta.ok && meta.value.publicId === publicId;
		} else if (response.status !== 404) continue;
		if (!matches) {
			await releasePublicId(env, publicId, columnId);
			result.publicMappingsRemoved += 1;
		}
	}

	return result;
}
