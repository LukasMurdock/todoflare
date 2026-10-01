/** R2 returns oldest timestamp keys first. Never select latest from one page. */
export async function listColumnBackups(
	bucket: Pick<R2Bucket, "list">,
	columnId: string,
): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: `columns/${columnId}/`, cursor, limit: 1000 });
		objects.push(...page.objects);
		if (!page.truncated) break;
		if (!page.cursor || page.cursor === cursor) throw new Error("backup_pagination_invalid");
		cursor = page.cursor;
	} while (cursor);
	return objects.sort((a, b) => b.key.localeCompare(a.key));
}

export async function latestColumnBackupKey(
	bucket: Pick<R2Bucket, "list">,
	columnId: string,
): Promise<string | null> {
	return (await listColumnBackups(bucket, columnId))[0]?.key ?? null;
}
