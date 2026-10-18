import type { UnifiedProvider } from "@platejs/yjs";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

/** A column's live document. The board binds its editor to `doc`. */
export interface ColumnDocument {
	doc: Y.Doc;
	/** Supplies remote cursors. Omit for single-user hosts. */
	awareness?: Awareness;
	/** Called when the column unmounts or the board switches documents. */
	release(): void;
}

/**
 * How the board gets content. The host owns persistence and transport; the
 * board only edits the returned Y.Doc. `open` resolves once the document holds
 * whatever the host could load (cache, first sync); the board seeds an empty
 * document with its initial content afterwards.
 */
export interface DocumentAdapter {
	open(columnId: string, signal: AbortSignal): Promise<ColumnDocument>;
}

/**
 * Plate's Yjs plugin requires at least one provider. The host already
 * connected the document, so the board hands Plate this inert one instead of
 * registering provider types in Plate's process-wide registry.
 */
export function hostOwnedProvider(document: { doc: Y.Doc; awareness: Awareness }): UnifiedProvider {
	return {
		type: "host",
		document: document.doc,
		awareness: document.awareness,
		isConnected: false,
		isSynced: true,
		connect() {},
		disconnect() {},
		destroy() {},
	};
}
