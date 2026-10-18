/**
 * DRAFT public API of the embeddable board (`@todoflare/board`), step 1.
 *
 * This file is a specification, not an implementation: the host examples in
 * ./hosts are type-checked against it (`pnpm check:board-spec`), so the API and
 * its documented uses cannot drift apart while the design is reviewed.
 *
 * Design rules, each traced to a measured finding in ../embeddable-board.md:
 * - The board never knows about accounts, HTTP, Cloudflare, or storage. Content
 *   arrives through a document adapter; everything else through props.
 * - The column list is controlled. In todoflare the server owns membership and
 *   order, so the board reports intents (create, delete, reorder) and renders
 *   whatever list the host passes back.
 * - Importing the package has no side effects, and rendering on a server
 *   produces stable markup; documents open only in effects.
 * - Nothing is page-global: no window listeners at import, no fixed
 *   positioning outside the board's root, no singletons shared between boards.
 */
import type { ReactNode, Ref } from "react";
import type { Value } from "platejs";
import type { PlatePlugin } from "platejs/react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

// ---------------------------------------------------------------------------
// Data

/** One column as the host describes it. The board never invents columns. */
export interface BoardColumn {
	/** Stable ID; the host chooses the format (todoflare uses UUIDs). */
	id: string;
	collapsed?: boolean;
	/** The user cannot edit content (shared read-only, storage failure, offline write freeze). */
	readOnly?: boolean;
	/** Remove action shown in the header. "confirm" asks first when the column has content. */
	removal?: "none" | "delete" | "hide";
	/** Short header label, for example "Shared by 1234...5678". */
	label?: string;
	/**
	 * Last known content, rendered read-only until the document opens and when
	 * rendering on a server, so SSR hosts ship real HTML instead of a skeleton.
	 */
	snapshot?: Value;
	/** Opaque host data passed back in callbacks and render props. */
	data?: unknown;
}

/** A column's live document. The board binds its editor to `doc`. */
export interface ColumnDocument {
	doc: Y.Doc;
	/** Supplies remote cursors. Omit for single-user hosts. */
	awareness?: Awareness;
	/** Called when the column unmounts or the board switches documents. */
	release(): void;
}

/**
 * How the board gets content. The host owns persistence and transport:
 * todoflare wraps its IndexedDB cache and Cloudflare socket; a simple host can
 * use `createMemoryDocuments` and persist snapshots from `onContentChange`.
 */
export interface DocumentAdapter {
	open(columnId: string, signal: AbortSignal): Promise<ColumnDocument>;
}

/** The board's editor writes into the Y.Doc under this shared type name. */
export declare const COLUMN_CONTENT_KEY: "content";

// ---------------------------------------------------------------------------
// Component

export interface TodoBoardProps {
	columns: readonly BoardColumn[];
	documents: DocumentAdapter;

	/**
	 * "loading" renders a skeleton and opens no documents. Hosts pass it until
	 * they know which columns exist, so placeholder columns never appear.
	 */
	status?: "loading" | "ready";

	// Intents. Omitting a callback hides the matching control. The board awaits
	// returned promises (to show pending state) and ignores their values.
	onCreateColumn?(): unknown;
	onRemoveColumn?(column: BoardColumn): unknown;
	onReorderColumns?(columnIds: string[]): void;
	onCollapsedChange?(column: BoardColumn, collapsed: boolean): void;

	/** Fires after local edits settle, with the column's content as Plate JSON. */
	onContentChange?(columnId: string, content: Value): void;
	/** Errors from the adapter or a host callback; the board stays mounted. */
	onError?(error: unknown, context: { columnId?: string; operation: string }): void;
	/** Cmd/Ctrl+click on a link. Defaults to opening a new tab. */
	onOpenLink?(url: string): void;

	/** Cursor label for this user; omitted means no cursor is broadcast. */
	identity?: { name: string; color: string };

	// Extension points.
	/** Extra controls in a column header, e.g. share menu and presence avatars. */
	renderColumnActions?(column: BoardColumn): ReactNode;
	/** Content above the columns inside the board, e.g. banners. */
	renderTopBar?(): ReactNode;
	/** Additional Plate plugins, appended after the built-in todo plugins. */
	editorPlugins?: readonly PlatePlugin[];
	/** Hide the built-in keyboard shortcuts button; the help dialog stays available through the ref. */
	showShortcutsButton?: boolean;

	theme?: "light" | "dark";
	className?: string;
	ref?: Ref<TodoBoardApi>;
}

/** Imperative control for hosts. */
export interface TodoBoardApi {
	focusColumn(columnId: string): void;
	scrollToColumn(columnId: string): void;
	/** Current content of a mounted column, or null if it is not open. */
	getColumnContent(columnId: string): Value | null;
	openShortcutsHelp(): void;
	/** Elements a host may anchor overlays to (todoflare's welcome tour). */
	getElement(part: "add-column" | "first-column" | "shortcuts-button"): HTMLElement | null;
}

export declare function TodoBoard(props: TodoBoardProps): ReactNode;

// ---------------------------------------------------------------------------
// Batteries for simple hosts (subpath "@todoflare/board/memory")

/** In-memory documents seeded from Plate JSON; nothing persists. */
export declare function createMemoryDocuments(initial?: Record<string, Value>): DocumentAdapter;

/**
 * Uncontrolled convenience state for hosts that do not own column membership:
 * returns props to spread onto <TodoBoard> plus the current list.
 */
export declare function useLocalBoard(initial?: readonly BoardColumn[]): {
	columns: readonly BoardColumn[];
	boardProps: Pick<TodoBoardProps, "columns" | "onCreateColumn" | "onRemoveColumn" | "onReorderColumns" | "onCollapsedChange">;
};
