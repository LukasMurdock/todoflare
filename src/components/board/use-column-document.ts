"use client";

import * as React from "react";
import type { ColumnDocument, DocumentAdapter } from "./documents";

const DocumentAdapterContext = React.createContext<DocumentAdapter | null>(null);

export const DocumentAdapterProvider = DocumentAdapterContext.Provider;

/**
 * Opens a column's document through the board's adapter and releases it when
 * the column unmounts or switches. Returns null until the document is open,
 * and always null without an adapter (or on the server, where effects never run).
 */
export function useColumnDocument(columnId: string, enabled: boolean): ColumnDocument | null {
	const adapter = React.useContext(DocumentAdapterContext);
	const [document, setDocument] = React.useState<ColumnDocument | null>(null);

	React.useEffect(() => {
		if (!adapter || !enabled) return;
		const controller = new AbortController();
		let opened: ColumnDocument | null = null;
		adapter.open(columnId, controller.signal).then(
			(result) => {
				if (controller.signal.aborted) {
					result.release();
					return;
				}
				opened = result;
				setDocument(result);
			},
			(error: unknown) => {
				if (!controller.signal.aborted) console.error(error);
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
	}, [adapter, columnId, enabled]);

	return document;
}
