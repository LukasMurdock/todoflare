export type SharedWithByColumn = Record<string, string[] | undefined>;

function arraysEqual(a: string[] | undefined, b: string[]): boolean {
	if (!a) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < b.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function upsertSharedWithByColumn(
	state: SharedWithByColumn,
	columnId: string,
	nextSharedWith: string[],
): SharedWithByColumn {
	if (arraysEqual(state[columnId], nextSharedWith)) {
		return state;
	}

	return { ...state, [columnId]: nextSharedWith };
}

export function removeSharedWithByColumn(
	state: SharedWithByColumn,
	columnId: string,
): SharedWithByColumn {
	if (!(columnId in state)) {
		return state;
	}

	const { [columnId]: _removed, ...rest } = state;
	return rest;
}
