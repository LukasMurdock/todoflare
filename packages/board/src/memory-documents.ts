import { Doc as YDoc } from "yjs";
import type { DocumentAdapter } from "./documents";

/**
 * Documents that live only in memory. A column opens empty and the board seeds
 * it from the column's snapshot; hosts persist content from onContentChange.
 */
export function createMemoryDocuments(): DocumentAdapter {
	return {
		async open() {
			const doc = new YDoc();
			return { doc, release: () => doc.destroy() };
		},
	};
}
