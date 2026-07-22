import type { ColumnMeta } from "../types/account";

export type LifecycleOperation =
	| {
			kind: "create";
			operationId: string;
			createdAt: number;
			meta: ColumnMeta;
	  }
	| {
			kind: "delete" | "restore" | "enable-public" | "disable-public";
			operationId: string;
			createdAt: number;
			columnId: string;
			accountId: string;
	  }
	| {
			kind: "share" | "revoke";
			operationId: string;
			createdAt: number;
			columnId: string;
			accountId: string;
			targetAccountId: string;
	  };

interface JournalStore {
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export function lifecycleOperationKey(operationId: string): string {
	return `lifecycle-operation:${operationId}`;
}

export async function beginLifecycleOperation(
	store: JournalStore,
	operation: LifecycleOperation,
): Promise<void> {
	await store.put(lifecycleOperationKey(operation.operationId), JSON.stringify(operation));
}

export async function completeLifecycleOperation(
	store: JournalStore,
	operationId: string,
): Promise<void> {
	await store.delete(lifecycleOperationKey(operationId));
}

export async function registerColumn(
	store: Pick<JournalStore, "put">,
	meta: ColumnMeta,
): Promise<void> {
	await store.put(`column-registry:${meta.id}`, JSON.stringify(meta));
}
