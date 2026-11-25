export type SharedWithByColumn = Record<string, Array<string> | undefined>;

function arraysEqual(a: Array<string> | undefined, b: Array<string>): boolean {
	if (!a) {return false;}
	if (a.length !== b.length) {return false;}
	for (let i = 0; i < b.length; i += 1) {
		if (a[i] !== b[i]) {return false;}
	}
	return true;
}

export function upsertSharedWithByColumn(
	state: SharedWithByColumn,
	columnId: string,
	nextSharedWith: Array<string>,
) {
	if (arraysEqual(state[columnId], nextSharedWith)) {
		return state;
	}

	return { ...state, [columnId]: nextSharedWith };
}

export function removeSharedWithByColumn(
	state: SharedWithByColumn,
	columnId: string,
) {
	if (!(columnId in state)) {
		return state;
	}

	const { [columnId]: _removed, ...rest } = state;
	return rest;
}
