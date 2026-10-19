"use client";

import * as React from "react";
import type { Value } from "platejs";
import type { AnyPluginConfig } from "platejs";
import type { PlatePlugin } from "platejs/react";

/** What the board needs to know about one open editor. */
export interface OpenEditor {
	focus(): void;
	getContent(): Value;
}

/** Host hooks and the registry of open editors, shared by every column of one board. */
export interface BoardContextValue {
	openLink(url: string): void;
	reportError(error: unknown, context: { columnId?: string; operation: string }): void;
	editorPlugins: readonly PlatePlugin<AnyPluginConfig>[];
	registerEditor(columnId: string, editor: OpenEditor): () => void;
	/** The column's live content, or null while its editor is not open. */
	getEditorContent(columnId: string): Value | null;
}

export function defaultOpenLink(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
}

function defaultReportError(error: unknown) {
	console.error(error);
}

const noPlugins: readonly PlatePlugin<AnyPluginConfig>[] = [];

const BoardContext = React.createContext<BoardContextValue>({
	openLink: defaultOpenLink,
	reportError: defaultReportError,
	editorPlugins: noPlugins,
	registerEditor: () => () => {},
	getEditorContent: () => null,
});

export const BoardContextProvider = BoardContext.Provider;

export function useBoardContext(): BoardContextValue {
	return React.useContext(BoardContext);
}

/** Creates the board's context value; the editor registry lives as long as the board. */
export function useBoardContextValue({
	onOpenLink,
	onError,
	editorPlugins,
}: {
	onOpenLink?: (url: string) => void;
	onError?: (error: unknown, context: { columnId?: string; operation: string }) => void;
	editorPlugins?: readonly PlatePlugin<AnyPluginConfig>[];
}): { value: BoardContextValue; editors: Map<string, OpenEditor> } {
	const [editors] = React.useState(() => new Map<string, OpenEditor>());
	const hooks = React.useRef({ onOpenLink, onError });
	React.useEffect(() => {
		hooks.current = { onOpenLink, onError };
	});
	const value = React.useMemo<BoardContextValue>(
		() => ({
			openLink: (url) => (hooks.current.onOpenLink ?? defaultOpenLink)(url),
			reportError: (error, context) => (hooks.current.onError ?? defaultReportError)(error, context),
			editorPlugins: editorPlugins ?? noPlugins,
			registerEditor(columnId, editor) {
				editors.set(columnId, editor);
				return () => {
					if (editors.get(columnId) === editor) editors.delete(columnId);
				};
			},
			getEditorContent: (columnId) => editors.get(columnId)?.getContent() ?? null,
		}),
		[editors, editorPlugins],
	);
	return { value, editors };
}
