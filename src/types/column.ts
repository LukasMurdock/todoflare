import type { Value } from "platejs";

export interface Column {
	id: string;
	value: Value;
	collapsed?: boolean;
}

export const EMPTY_COLUMN_VALUE: Value = [
	{
		type: "p",
		children: [{ text: "" }],
	},
];

export function createEmptyColumn(): Column {
	return {
		id: crypto.randomUUID(),
		value: EMPTY_COLUMN_VALUE,
	};
}

export function isColumnEmpty(column: Column): boolean {
	if (column.value.length === 0) return true;
	if (column.value.length === 1) {
		const firstBlock = column.value[0];
		if (
			firstBlock.type === "p" &&
			Array.isArray(firstBlock.children) &&
			firstBlock.children.length === 1
		) {
			const firstChild = firstBlock.children[0];
			return (
				typeof firstChild === "object" &&
				"text" in firstChild &&
				firstChild.text === ""
			);
		}
	}
	return false;
}
