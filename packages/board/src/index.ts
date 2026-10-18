/**
 * @todoflare/board: the embeddable todo board.
 *
 * Hosts render <TodoBoard> with their columns and a DocumentAdapter, and own
 * everything else: identity, persistence, transport, sharing, and page chrome.
 * Only what is exported here is public; deep imports are not supported.
 */
export { TodoBoard } from "./TodoBoard";
export type { BoardColumn, TodoBoardApi, TodoBoardProps } from "./types";
export type { ColumnDocument, DocumentAdapter } from "./documents";
/** Column content as Plate JSON, re-exported so hosts need no direct platejs dependency. */
export type { Value } from "platejs";
export { createMemoryDocuments } from "./memory-documents";
export { ColumnSnapshot } from "./ColumnSnapshot";
export { isEmptyContent } from "./content";
/** Where overlays rendered from slots (renderColumnActions, renderTopBar) should portal. */
export { usePortalContainer } from "./portal-container";
