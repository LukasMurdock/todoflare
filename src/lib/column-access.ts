import { normalizeAccountId } from "./account";

export interface ColumnAccessMetadata {
	ownerId: string;
	sharedWith: readonly string[];
}

export function sameAccountId(left: string, right: string): boolean {
	return normalizeAccountId(left) === normalizeAccountId(right);
}

export function normalizeAccountIdSet(ids: Iterable<string>): Set<string> {
	return new Set(Array.from(ids, normalizeAccountId));
}

export function isColumnOwner(
	meta: Pick<ColumnAccessMetadata, "ownerId">,
	accountId: string | null | undefined,
): boolean {
	if (!accountId) return false;
	return sameAccountId(meta.ownerId, accountId);
}

export function hasColumnAccess(
	meta: ColumnAccessMetadata,
	accountId: string | null | undefined,
): boolean {
	if (!accountId) return false;
	if (isColumnOwner(meta, accountId)) return true;
	return normalizeAccountIdSet(meta.sharedWith).has(normalizeAccountId(accountId));
}
