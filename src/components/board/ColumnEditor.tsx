"use client";

import * as React from "react";
import type { TText, Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";

import { cn } from "@/lib/utils";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { RemoteCursorOverlay } from "@/components/ui/remote-cursor-overlay";
import { columnEditorPlugins, findUrlAtOffset, normalizeUrl } from "./column-editor-plugins";
import { ColumnSnapshot } from "./ColumnSnapshot";
import { hostOwnedProvider } from "./documents";
import { useModifierKeyPressed } from "./modifier-key";
import { useColumnDocument, type OpenColumnDocument } from "./use-column-document";

const PLACEHOLDER = "Start typing...";

export interface ColumnEditorProps {
	columnId: string;
	/**
	 * Last known content: rendered until the document opens, and used to seed
	 * the document if it opens empty. Read once per opened document.
	 */
	snapshot?: Value;
	readOnly: boolean;
	/** This user's cursor label; omitted means no cursors are shown or sent. */
	identity?: { name: string; color: string };
	onContentChange?(columnId: string, content: Value): void;
}

/** One column's editor, bound to the Y.Doc the board's document adapter opens. */
export function ColumnEditor({ columnId, snapshot, readOnly, identity, onContentChange }: ColumnEditorProps) {
	const cmdPressed = useModifierKeyPressed();
	const columnDocument = useColumnDocument(columnId, true);
	const [boundDocument, setBoundDocument] = React.useState<OpenColumnDocument | null>(null);
	const isReady = columnDocument !== null && boundDocument === columnDocument;

	// Read at bind time only: guest hosts pass the latest content on every change.
	const snapshotRef = React.useRef(snapshot);
	const onContentChangeRef = React.useRef(onContentChange);
	React.useEffect(() => {
		snapshotRef.current = snapshot;
		onContentChangeRef.current = onContentChange;
	});

	const identityName = identity?.name;
	const identityColor = identity?.color;
	const plugins = React.useMemo(() => {
		if (!columnDocument) return columnEditorPlugins;
		const cursors = identityName && identityColor ? { data: { name: identityName, color: identityColor } } : null;
		return [
			...columnEditorPlugins,
			YjsPlugin.configure({
				render: cursors ? { afterEditable: RemoteCursorOverlay } : {},
				options: {
					ydoc: columnDocument.doc,
					awareness: columnDocument.awareness,
					providers: [hostOwnedProvider(columnDocument)],
					cursors,
				},
			} as never),
		];
	}, [columnDocument, identityName, identityColor]);

	const editor = usePlateEditor({ id: columnId, plugins, value: [] }, [plugins]);

	// Bind the editor to the opened document. The adapter already loaded and
	// connected it, so Plate only seeds an empty document and connects.
	React.useEffect(() => {
		if (!editor || !columnDocument) return;

		let cancelled = false;
		let didInit = false;
		const api = editor.getApi(YjsPlugin);

		const initPromise = (async () => {
			try {
				await api.yjs.init({ id: columnId, autoConnect: false, value: snapshotRef.current });
				didInit = true;
			} catch (err) {
				console.error(err);
			}
			if (!cancelled) setBoundDocument(columnDocument);
		})();

		return () => {
			cancelled = true;
			void initPromise.finally(() => {
				if (!didInit) return;
				try {
					api.yjs.destroy();
				} catch {
					// ignore
				}
			});
		};
	}, [editor, columnId, columnDocument]);

	const handleChange = React.useCallback(
		({ value }: { value: Value }) => onContentChangeRef.current?.(columnId, value),
		[columnId],
	);

	// Cmd/Ctrl+click opens links.
	const handleClick = React.useCallback((e: React.MouseEvent) => {
		if (!e.metaKey && !e.ctrlKey) return;

		const target = e.target as HTMLElement;
		if (!target.closest("[data-slate-node='text']")) return;

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		const textNode = range.startContainer;
		if (textNode.nodeType !== Node.TEXT_NODE) return;

		const url = findUrlAtOffset(textNode.textContent || "", range.startOffset);
		if (url) {
			e.preventDefault();
			e.stopPropagation();
			window.open(normalizeUrl(url), "_blank", "noopener,noreferrer");
		}
	}, []);

	const renderLeaf = React.useCallback(
		(props: {
			attributes: React.HTMLAttributes<HTMLSpanElement>;
			children: React.ReactNode;
			leaf: TText & { url?: string };
		}) => {
			const { attributes, children, leaf } = props;
			if (leaf.url) {
				return (
					<span {...attributes} className="url-text" data-url={leaf.url}>
						{children}
					</span>
				);
			}
			return <span {...attributes}>{children}</span>;
		},
		[],
	);

	let content: React.ReactNode;
	if (isReady) {
		content = (
			<EditorContainer className={cn("h-full", cmdPressed && "cmd-pressed")} onClick={handleClick}>
				<Editor
					variant="column"
					readOnly={readOnly}
					role="textbox"
					aria-multiline="true"
					aria-label="Todo editor"
					placeholder={PLACEHOLDER}
					renderLeaf={renderLeaf}
				/>
			</EditorContainer>
		);
	} else if (snapshot) {
		content = (
			<EditorContainer className="h-full">
				<ColumnSnapshot value={snapshot} placeholder={PLACEHOLDER} />
			</EditorContainer>
		);
	} else {
		content = (
			<EditorContainer className="h-full px-4 py-3 text-sm text-muted-foreground">
				Preparing collaborative editor...
			</EditorContainer>
		);
	}

	return (
		<Plate editor={editor} onChange={isReady ? handleChange : undefined}>
			{content}
		</Plate>
	);
}
