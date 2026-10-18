"use client";

import * as React from "react";
import { Awareness } from "y-protocols/awareness";
import type { ColumnDocument, DocumentAdapter } from "./documents";
import { useBoardContext } from "./board-context";

/** An opened document whose awareness is always present; the board owns one it created. */
export type OpenColumnDocument = ColumnDocument & { awareness: Awareness };

function withAwareness(document: ColumnDocument): OpenColumnDocument {
	if (document.awareness) return document as OpenColumnDocument;
	const awareness = new Awareness(document.doc);
	return {
		...document,
		awareness,
		release() {
			awareness.destroy();
			document.release();
		},
	};
}

const DocumentAdapterContext = React.createContext<DocumentAdapter | null>(null);

export const DocumentAdapterProvider = DocumentAdapterContext.Provider;

/**
 * Opens a column's document through the board's adapter and releases it when
 * the column unmounts or switches. Returns null until the document is open,
 * and always null without an adapter (or on the server, where effects never run).
 */
export function useColumnDocument(columnId: string, enabled: boolean): OpenColumnDocument | null {
	const adapter = React.useContext(DocumentAdapterContext);
	const { reportError } = useBoardContext();
	const [document, setDocument] = React.useState<OpenColumnDocument | null>(null);

	React.useEffect(() => {
		if (!adapter || !enabled) return;
		const controller = new AbortController();
		let opened: OpenColumnDocument | null = null;
		adapter.open(columnId, controller.signal).then(
			(result) => {
				if (controller.signal.aborted) {
					result.release();
					return;
				}
				opened = withAwareness(result);
				setDocument(opened);
			},
			(error: unknown) => {
				if (!controller.signal.aborted) reportError(error, { columnId, operation: "open-document" });
			},
		);
		return () => {
			controller.abort();
			setDocument(null);
			// Released after this commit's cleanups, so the editor unbinds before the document is torn down.
			if (opened) {
				const toRelease = opened;
				queueMicrotask(() => toRelease.release());
			}
		};
	}, [adapter, columnId, enabled, reportError]);

	return document;
}
