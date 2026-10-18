import type { ReactNode, Ref } from "react";
import type { Value } from "platejs";
import type { DocumentAdapter } from "./documents";

/** One column as the host describes it. The board never invents columns. */
export interface BoardColumn {
	/** Stable ID; the host chooses the format (todoflare uses UUIDs). */
	id: string;
	collapsed?: boolean;
	/** The user cannot edit content (storage failure, offline write freeze). */
	readOnly?: boolean;
	/**
	 * The header's remove control. "delete" asks for confirmation when the
	 * column's snapshot has content; "hide" removes it from this board only.
	 */
	removal?: "none" | "delete" | "hide";
	/** Short header text, for example "Shared by 1234...5678". */
	label?: string;
	/**
	 * Last known content: rendered until the document opens (and on a server),
	 * and used to seed the document if it opens empty.
	 */
	snapshot?: Value;
}

export interface TodoBoardProps {
	columns: readonly BoardColumn[];
	documents: DocumentAdapter;
	/**
	 * "loading" renders no columns and opens no documents. Hosts pass it until
	 * they know which columns exist, so placeholder columns never appear.
	 */
	status?: "loading" | "ready";

	// Intents. Omitting a callback hides its control. Returned promises are
	// awaited by the host's own code paths; the board ignores their values.
	onCreateColumn?(): unknown;
	onRemoveColumn?(column: BoardColumn): unknown;
	onReorderColumns?(columnIds: string[]): unknown;
	onCollapsedChange?(column: BoardColumn, collapsed: boolean): void;
	/** Every editor change (including selection moves), as Plate JSON. */
	onContentChange?(columnId: string, content: Value): void;

	/** This user's cursor label; omitted means no cursors are shown or sent. */
	identity?: { name: string; color: string };

	/** Extra controls in a column header, before the remove control. */
	renderColumnActions?(column: BoardColumn): ReactNode;
	/** Content at the top of the board, before the columns (banners, badges). */
	renderTopBar?(): ReactNode;

	className?: string;
	ref?: Ref<TodoBoardApi>;
}

/** Imperative control for hosts. */
export interface TodoBoardApi {
	openShortcutsHelp(): void;
	/** Elements a host may anchor overlays to (todoflare's welcome tour). */
	getElement(part: "add-column" | "first-column" | "shortcuts-button"): HTMLElement | null;
}
