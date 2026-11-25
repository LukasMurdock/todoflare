import { z } from "zod";
import { columnMetaRecordSchema } from "./persistence-records";
import type { ColumnMeta } from "../types/account";

const journalEntry = z.object({ operationId: z.string().min(1), createdAt: z.number() });
const columnEntry = journalEntry.extend({ columnId: z.string(), accountId: z.string() });
export const lifecycleOperationSchema = z.discriminatedUnion("kind", [
	journalEntry.extend({ kind: z.literal("create"), meta: columnMetaRecordSchema }),
	columnEntry.extend({ kind: z.enum(["delete", "restore", "enable-public", "disable-public"]) }),
	columnEntry.extend({ kind: z.enum(["share", "revoke"]), targetAccountId: z.string() }),
]);
export type LifecycleOperation = z.output<typeof lifecycleOperationSchema>;

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
