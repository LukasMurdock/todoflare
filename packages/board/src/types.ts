import type { ReactNode, Ref } from "react";
import type { AnyPluginConfig, Value } from "platejs";
import type { PlatePlugin } from "platejs/react";
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

	/**
	 * Errors from the document adapter, the editor, or a rejected intent
	 * callback. The board stays mounted. Defaults to console.error.
	 */
	onError?(error: unknown, context: { columnId?: string; operation: string }): void;
	/** Cmd/Ctrl+click on a link. Defaults to opening a new tab. */
	onOpenLink?(url: string): void;

	/** This user's cursor label; omitted means no cursors are shown or sent. */
	identity?: { name: string; color: string };

	/**
	 * Additional Plate plugins for the live editor, after the built-in ones.
	 * Snapshots render with the built-in blocks only. Pass a stable array.
	 */
	editorPlugins?: readonly PlatePlugin<AnyPluginConfig>[];
	/**
	 * Where the keyboard-shortcuts button sits: "board" (bottom-left of the
	 * board, the default), "viewport" (fixed to the window, for hosts where the
	 * board is the page), or "none". Mod+/ inside the board works either way.
	 */
	shortcutsButton?: "board" | "viewport" | "none";

	/** Extra controls in a column header, before the remove control. */
	renderColumnActions?(column: BoardColumn): ReactNode;
	/** Content at the top of the board, before the columns (banners, badges). */
	renderTopBar?(): ReactNode;

	className?: string;
	ref?: Ref<TodoBoardApi>;
}

/** Imperative control for hosts. */
export interface TodoBoardApi {
	/** Places the caret at the end of an open column. Returns false if it is not open. */
	focusColumn(columnId: string): boolean;
	scrollToColumn(columnId: string): void;
	/** Current content of an open column, or null if it is not open. */
	getColumnContent(columnId: string): Value | null;
	openShortcutsHelp(): void;
	/** Elements a host may anchor overlays to (todoflare's welcome tour). */
	getElement(part: "add-column" | "first-column" | "shortcuts-button"): HTMLElement | null;
}
