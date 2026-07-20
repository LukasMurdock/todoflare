/** Map in input order while limiting simultaneously active asynchronous work. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError("Concurrency limit must be a positive integer");
	}
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex += 1;
				results[index] = await mapper(items[index]!, index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}
