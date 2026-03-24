"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Value, TText, NodeEntry, Range } from "platejs";
import { Plate, usePlateEditor, createPlatePlugin } from "platejs/react";
import { KEYS } from "platejs";
import { H1Plugin, H2Plugin, H3Plugin } from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { toggleList, someList, someTodoList } from "@platejs/list";
import { AutoformatPlugin, type AutoformatRule } from "@platejs/autoformat";
import { IndentPlugin } from "@platejs/indent/react";
import { YjsPlugin } from "@platejs/yjs/react";

import type { Column } from "@/types/column";
import { EMPTY_COLUMN_VALUE, isColumnEmpty } from "@/types/column";
import { cn } from "@/lib/utils";
import { displayAccountId, getAccountColor, truncateAccountId } from "@/lib/account";
import { useSyncContext } from "@/contexts/sync-context";
import "@/lib/collaboration/cloudflare-yjs-provider";
import { RemoteCursorOverlay } from "@/components/ui/remote-cursor-overlay";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { H1Element, H2Element, H3Element } from "@/components/ui/heading-node";
import { BlockList } from "@/components/ui/block-list";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/confirm-dialog";
import { ShareMenu } from "@/components/column/ShareMenu";
import { PresenceAvatars } from "@/components/column/PresenceAvatars";
import { useAccount } from "@/hooks/useAccount";

export interface TodoColumnProps {
	column: Column;
	onUpdate: (id: string, value: Value) => void;
	onRemove: (id: string) => void;
	onToggleCollapse: (id: string) => void;
	canRemove: boolean;
	isOwner?: boolean;
	sharedBy?: string | null;
}

export function TodoColumn({
	column,
	onUpdate,
	onRemove,
	onToggleCollapse,
	canRemove,
	isOwner = true,
	sharedBy = null,
}: TodoColumnProps) {
	const { isAuthenticated } = useAccount();

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: column.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	const isEmpty = isColumnEmpty(column);

	const handleRemove = () => {
		onRemove(column.id);
	};

	const handleToggleCollapse = () => {
		onToggleCollapse(column.id);
	};

	// Collapsed state: narrow column with just drag handle and expand button
	if (column.collapsed) {
		return (
			<div
				ref={setNodeRef}
				style={style}
				className={cn(
					"flex h-full w-10 flex-shrink-0 flex-col border-r border-border bg-background",
					isDragging && "opacity-50"
				)}
			>
				<div className="flex flex-col w-10 items-center gap-1 border-b border-border bg-muted/30 py-2">
					{/* Drag handle */}
					<button
						className="cursor-grab rounded p-1 hover:bg-muted active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{/* Expand button */}
					<button
						onClick={handleToggleCollapse}
						type="button"
						aria-label="Expand column"
						className="rounded p-1 hover:bg-muted"
						title="Expand column"
					>
						<ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex h-full w-80 flex-shrink-0 flex-col border-r border-border bg-background",
				isDragging && "opacity-50"
			)}
		>
			{/* Column header with drag handle, collapse, share, presence, and delete */}
			<div className="flex h-10 flex-shrink-0 items-start justify-between border-b border-border bg-muted/30 px-2 py-2">
				<div className="flex items-center gap-1">
					{/* Drag handle */}
					<button
						className="cursor-grab rounded p-1 hover:bg-muted active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{/* Collapse button */}
					<button
						onClick={handleToggleCollapse}
						type="button"
						aria-label="Collapse column"
						className="rounded p-1 hover:bg-muted"
						title="Collapse column"
					>
						<ChevronLeftIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{/* Shared indicator */}
					{!isOwner && sharedBy && (
						<span className="text-xs text-muted-foreground px-1">
							Shared by {truncateAccountId(sharedBy)}
						</span>
					)}
				</div>

				<div className="flex items-center gap-1">
					{/* Presence avatars */}
					<PresenceAvatars columnId={column.id} />

					{/* Share button (owner only) */}
					{isOwner && isAuthenticated && (
						<ShareMenu
							columnId={column.id}
							columnMeta={{
								id: column.id,
								ownerId: column.ownerId || "",
								sharedWith: column.sharedWith || [],
								publicId: column.publicId ?? null,
								createdAt: 0,
							}}
						/>
					)}

					{/* Delete/Hide button */}
					{canRemove && (
						<>
							{isEmpty || !isOwner ? (
								<button
									onClick={handleRemove}
									className="rounded p-1 hover:bg-muted"
									title={isOwner ? "Delete column" : "Hide column"}
								>
									<XIcon className="h-4 w-4 text-muted-foreground" />
								</button>
							) : (
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<button className="rounded p-1 hover:bg-muted">
											<XIcon className="h-4 w-4 text-muted-foreground" />
										</button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												Delete column?
											</AlertDialogTitle>
											<AlertDialogDescription>
												This column has content. This action
												cannot be undone.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>
												Cancel
											</AlertDialogCancel>
											<AlertDialogAction
												onClick={handleRemove}
											>
												Delete
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
						</>
					)}
				</div>
			</div>

			{/* Editor */}
			<div className="flex-1 overflow-hidden">
				<TodoEditor column={column} onUpdate={onUpdate} />
			</div>
		</div>
	);
}

interface TodoEditorProps {
	column: Column;
	onUpdate: (id: string, value: Value) => void;
}

// Plugin for list keyboard shortcuts
const ListShortcutsPlugin = createPlatePlugin({
	key: "listShortcuts",
	handlers: {
		onKeyDown: ({ editor, event }) => {
			// Mod+E: Rotate list types
			if ((event.metaKey || event.ctrlKey) && event.key === "e") {
				event.preventDefault();

				if (someTodoList(editor)) {
					// Todo → Bullet (remove checked property)
					editor.tf.unsetNodes(["checked"]);
					editor.tf.setNodes({ listStyleType: KEYS.ul });
				} else if (someList(editor, KEYS.ol)) {
					// Ordered → Todo
					editor.tf.setNodes({
						listStyleType: KEYS.listTodo,
						checked: false,
					});
				} else if (someList(editor, KEYS.ul)) {
					// Bullet → Ordered
					editor.tf.setNodes({ listStyleType: KEYS.ol });
				} else {
					// Not in list → Create bullet list
					toggleList(editor, { listStyleType: KEYS.ul });
				}

				return true;
			}

			// Mod+Enter: Toggle todo completion
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				if (someTodoList(editor)) {
					event.preventDefault();

					// Get current checked state and toggle it
					const nodes = Array.from(
						editor.api.nodes({
							match: (n) =>
								"listStyleType" in n &&
								n.listStyleType === KEYS.listTodo,
							mode: "lowest",
						})
					);

					if (nodes.length > 0) {
						const [node] = nodes[0];
						const currentChecked =
							(node as { checked?: boolean }).checked ?? false;
						editor.tf.setNodes({ checked: !currentChecked });
					}

					return true;
				}
			}
		},
	},
});

// URL regex pattern - matches URLs including bare domains and subdomains
const URL_REGEX =
	/(?:https?:\/\/[^\s<>]+|www\.[^\s<>]+|(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(?:\/[^\s<>]*)?)/g;

// Find URL at a specific offset in text
function findUrlAtOffset(text: string, offset: number): string | null {
	let match;
	URL_REGEX.lastIndex = 0;
	while ((match = URL_REGEX.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) {
			return match[0];
		}
	}
	return null;
}

// Normalize URL to ensure it has a protocol
function normalizeUrl(url: string): string {
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return url;
	}
	if (url.startsWith("www.")) {
		return `https://${url}`;
	}
	return `https://${url}`;
}

// Find all URL ranges in a text node for decoration
function findUrlRanges(node: TText, path: number[]): Range[] {
	const text = node.text;
	const ranges: Range[] = [];

	let match;
	URL_REGEX.lastIndex = 0;
	while ((match = URL_REGEX.exec(text)) !== null) {
		ranges.push({
			anchor: { path, offset: match.index },
			focus: { path, offset: match.index + match[0].length },
			url: match[0],
		} as Range & { url: string });
	}

	return ranges;
}

// URL decoration plugin - adds url property to decorated ranges
const UrlDecorationPlugin = createPlatePlugin({
	key: "urlDecoration",
	decorate: ({ entry }) => {
		const [node, path] = entry as NodeEntry<TText>;
		// Check if node is a text node (has a 'text' property)
		if (typeof (node as TText).text !== "string") return [];
		return findUrlRanges(node as TText, path);
	},
});

const autoformatRules: AutoformatRule[] = [
	// Headings
	{
		match: "# ",
		mode: "block",
		type: KEYS.h1,
	},
	{
		match: "## ",
		mode: "block",
		type: KEYS.h2,
	},
	{
		match: "### ",
		mode: "block",
		type: KEYS.h3,
	},
	// Todo lists (must come before bullet lists to match first)
	{
		match: ["- [ ] ", "[] "],
		mode: "block",
		type: "list",
		format: (editor) => {
			toggleList(editor, { listStyleType: KEYS.listTodo });
			editor.tf.setNodes({
				checked: false,
				listStyleType: KEYS.listTodo,
			});
		},
	},
	{
		match: ["- [x] ", "[x] "],
		mode: "block",
		type: "list",
		format: (editor) => {
			toggleList(editor, { listStyleType: KEYS.listTodo });
			editor.tf.setNodes({ checked: true, listStyleType: KEYS.listTodo });
		},
	},
	// Bullet lists - trigger on word characters to allow "- [ ]" for todos
	{
		match: ["- ", "* "],
		mode: "block",
		type: "list",
		// Trigger on alphanumeric characters instead of space
		trigger: [
			..."abcdefghijklmnopqrstuvwxyz",
			..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
			..."0123456789",
		],
		insertTrigger: true,
		format: (editor) => {
			toggleList(editor, { listStyleType: KEYS.ul });
		},
	},
	// Ordered lists (matches 1. 2. 3. etc)
	{
		match: [String.raw`^\d+\.$ `, String.raw`^\d+\)$ `],
		matchByRegex: true,
		mode: "block",
		type: "list",
		format: (editor) => {
			toggleList(editor, { listStyleType: KEYS.ol });
		},
	},
];

// Global state for Cmd key - shared across all editors
let cmdKeyPressed = false;
const cmdKeyListeners = new Set<() => void>();

function subscribeToCmdKey(listener: () => void) {
	cmdKeyListeners.add(listener);
	return () => {
		cmdKeyListeners.delete(listener);
	};
}

function notifyCmdKeyListeners() {
	cmdKeyListeners.forEach((listener) => listener());
}

// Initialize global key listeners once
if (typeof window !== "undefined") {
	const handleKeyDown = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && !cmdKeyPressed) {
			cmdKeyPressed = true;
			notifyCmdKeyListeners();
		}
	};

	const handleKeyUp = (e: KeyboardEvent) => {
		if (!e.metaKey && !e.ctrlKey && cmdKeyPressed) {
			cmdKeyPressed = false;
			notifyCmdKeyListeners();
		}
	};

	const handleBlur = () => {
		if (cmdKeyPressed) {
			cmdKeyPressed = false;
			notifyCmdKeyListeners();
		}
	};

	window.addEventListener("keydown", handleKeyDown);
	window.addEventListener("keyup", handleKeyUp);
	window.addEventListener("blur", handleBlur);
}

function useCmdKeyPressed() {
	const [pressed, setPressed] = React.useState(cmdKeyPressed);

	React.useEffect(() => {
		return subscribeToCmdKey(() => setPressed(cmdKeyPressed));
	}, []);

	return pressed;
}

function TodoEditor({ column, onUpdate }: TodoEditorProps) {
	const cmdPressed = useCmdKeyPressed();
	const {
		accountId,
		account,
		connectToColumn,
		disconnectFromColumn,
		onColumnMessage,
		sendUpdate,
		sendAwareness,
	} = useSyncContext();

	const isSyncedMode = !!accountId && !!account;

	// Deterministic connection: make sure at least one column WS is opened
	// while an editor is mounted. SyncContext ref-counting prevents flapping.
	React.useEffect(() => {
		if (!isSyncedMode) return;
		connectToColumn(column.id);
		return () => disconnectFromColumn(column.id);
	}, [isSyncedMode, connectToColumn, disconnectFromColumn, column.id]);

	const plugins = React.useMemo(() => {
		const base: any[] = [
			H1Plugin.withComponent(H1Element),
			H2Plugin.withComponent(H2Element),
			H3Plugin.withComponent(H3Element),
			ListPlugin.configure({
				inject: {
					targetPlugins: [...KEYS.heading, KEYS.p],
				},
				render: {
					belowNodes: BlockList,
				},
			}),
			IndentPlugin.configure({
				inject: {
					targetPlugins: [...KEYS.heading, KEYS.p],
				},
				options: {
					offset: 16,
				},
			}),
			AutoformatPlugin.configure({
				options: {
					enableUndoOnDelete: true,
					rules: autoformatRules,
				},
			}),
			ListShortcutsPlugin,
			UrlDecorationPlugin,
		];

		if (isSyncedMode && accountId) {
			base.push(
				(YjsPlugin.configure({
					render: {
						afterEditable: RemoteCursorOverlay,
					},
					options: {
						providers: [
							{
								type: "cloudflare",
								options: {
									columnId: column.id,
									transport: {
										connectToColumn,
										disconnectFromColumn,
										onColumnMessage,
										sendUpdate,
										sendAwareness,
									},
								},
							},
						] as any,
						cursors: {
							data: {
								name: displayAccountId(accountId),
								color: getAccountColor(accountId),
							},
						},
					},
				}) as any),
			);
		}

		return base;
	}, [
		isSyncedMode,
		accountId,
		column.id,
		connectToColumn,
		disconnectFromColumn,
		onColumnMessage,
		sendUpdate,
		sendAwareness,
	]);

	const editor = usePlateEditor(
		isSyncedMode
			? {
				id: column.id,
				plugins,
				value: [],
			}
			: {
				id: column.id,
				plugins,
				value: column.value,
			},
		// Ensure the editor is recreated when collaboration plugins change.
		[isSyncedMode, accountId, plugins],
	);

	// Initialize Yjs binding after the editor mounts.
	React.useEffect(() => {
		if (!isSyncedMode || !editor) return;

		let cancelled = false;
		let didInit = false;
		let didDestroy = false;
		const api = editor.getApi(YjsPlugin);

		const initPromise = (async () => {
			try {
				await api.yjs.init({
					id: column.id,
					autoConnect: true,
				});
				didInit = true;

				if (cancelled) {
					// If StrictMode unmounted us before init finished, clean up now.
					try {
						api.yjs.destroy();
						didDestroy = true;
					} catch {
						// ignore
					}
					return;
				}

				// init(autoConnect: true) handles provider connections.
			} catch (err) {
				// dev StrictMode can race connect/disconnect; ignore duplicates.
				if (String(err).includes("already connected")) return;
				console.error(err);
			}
		})();

		return () => {
			cancelled = true;
			void initPromise.finally(() => {
				if (!didInit) return;
				if (didDestroy) return;
				try {
					api.yjs.destroy();
				} catch {
					// ignore
				}
			});
		};
	}, [isSyncedMode, editor, column.id]);

	// For local-only mode, keep Plate in sync with `column.value`.
	const isApplyingExternalValueRef = React.useRef(false);
	const lastLocalValueRef = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (isSyncedMode) return;

		const setValue = (editor as any)?.tf?.setValue as
			| ((v: Value) => void)
			| undefined;
		if (typeof setValue !== "function") return;

		let serialized: string;
		try {
			serialized = JSON.stringify(column.value);
		} catch {
			return;
		}

		if (serialized === lastLocalValueRef.current) return;

		isApplyingExternalValueRef.current = true;
		try {
			setValue(column.value);
			lastLocalValueRef.current = serialized;
		} finally {
			isApplyingExternalValueRef.current = false;
		}
	}, [editor, column.value, isSyncedMode]);

	const handleChange = React.useCallback(
		({ value }: { value: Value }) => {
			if (isSyncedMode) return;
			if (isApplyingExternalValueRef.current) return;

			try {
				lastLocalValueRef.current = JSON.stringify(value);
			} catch {
				lastLocalValueRef.current = null;
			}

			onUpdate(column.id, value);
		},
		[column.id, onUpdate, isSyncedMode],
	);

	// Handle Cmd+Click on URLs
	const handleClick = React.useCallback((e: React.MouseEvent) => {
		if (!e.metaKey && !e.ctrlKey) return;

		const target = e.target as HTMLElement;
		if (!target.closest("[data-slate-node='text']")) return;

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		const textNode = range.startContainer;
		if (textNode.nodeType !== Node.TEXT_NODE) return;

		const text = textNode.textContent || "";
		const offset = range.startOffset;

		const url = findUrlAtOffset(text, offset);
		if (url) {
			e.preventDefault();
			e.stopPropagation();
			window.open(normalizeUrl(url), "_blank", "noopener,noreferrer");
		}
	}, []);

	// Custom leaf renderer for URL decorations
	const renderLeaf = React.useCallback(
		(props: {
			attributes: React.HTMLAttributes<HTMLSpanElement>;
			children: React.ReactNode;
			leaf: TText & { url?: string };
		}) => {
			const { attributes, children, leaf } = props;
			if (leaf.url) {
				return (
					<span
						{...attributes}
						className="url-text"
						data-url={leaf.url}
					>
						{children}
					</span>
				);
			}
			return <span {...attributes}>{children}</span>;
		},
		[],
	);

	const plate = (
		<EditorContainer
			className={cn("h-full", cmdPressed && "cmd-pressed")}
			onClick={handleClick}
		>
			<Editor
				variant="column"
				role="textbox"
				aria-multiline="true"
				aria-label="Todo editor"
				placeholder="Start typing..."
				renderLeaf={renderLeaf}
			/>
		</EditorContainer>
	);

	return isSyncedMode ? (
		<Plate editor={editor}>{plate}</Plate>
	) : (
		<Plate editor={editor} onChange={handleChange}>
			{plate}
		</Plate>
	);
}

function GripVerticalIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<circle cx="9" cy="12" r="1" />
			<circle cx="9" cy="5" r="1" />
			<circle cx="9" cy="19" r="1" />
			<circle cx="15" cy="12" r="1" />
			<circle cx="15" cy="5" r="1" />
			<circle cx="15" cy="19" r="1" />
		</svg>
	);
}

function XIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

function ChevronLeftIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="m15 18-6-6 6-6" />
		</svg>
	);
}

function ChevronRightIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}
