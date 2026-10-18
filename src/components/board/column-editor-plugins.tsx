"use client";

/**
 * The column editor's plugins, live and static, declared together: the static
 * list renders a column's snapshot before its document opens (and on the
 * server), so it must render exactly what the live editor renders.
 */
import type { NodeEntry, Range, TText } from "platejs";
import { createSlatePlugin, KEYS } from "platejs";
import { SlateLeaf, type SlateLeafProps } from "platejs/static";
import { createPlatePlugin } from "platejs/react";
import { BaseH1Plugin, BaseH2Plugin, BaseH3Plugin, HeadingRules } from "@platejs/basic-nodes";
import { H1Plugin, H2Plugin, H3Plugin } from "@platejs/basic-nodes/react";
import {
	BaseListPlugin,
	BulletedListRules,
	OrderedListRules,
	TaskListRules,
	someList,
	someTodoList,
	toggleList,
} from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { BaseIndentPlugin } from "@platejs/indent";
import { IndentPlugin } from "@platejs/indent/react";

import { BlockList } from "@/components/ui/block-list";
import { BlockListStatic } from "@/components/ui/block-list-static";
import { H1Element, H2Element, H3Element } from "@/components/ui/heading-node";
import { H1ElementStatic, H2ElementStatic, H3ElementStatic } from "@/components/ui/heading-node-static";

const BLOCK_TARGETS = [...KEYS.heading, KEYS.p];
const INDENT_OFFSET = 16;

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
			urlDecoration: true,
		} as Range & { url: string });
	}

	return ranges;
}

function decorateUrls({ entry }: { entry: NodeEntry }): Range[] {
	const [node, path] = entry as NodeEntry<TText>;
	// Only text nodes carry URLs.
	if (typeof (node as TText).text !== "string") return [];
	return findUrlRanges(node as TText, path);
}

// URL decoration plugin - adds url property to decorated ranges (rendered by the editor's renderLeaf)
const UrlDecorationPlugin = createPlatePlugin({
	key: "urlDecoration",
	decorate: decorateUrls,
});

/** The snapshot's URL leaf: the same span the live renderLeaf draws, so text runs split identically. */
function UrlLeafStatic(props: SlateLeafProps) {
	const url = (props.leaf as TText & { url?: string }).url;
	return <SlateLeaf {...props} className="url-text" attributes={{ ...props.attributes, "data-url": url }} />;
}

const UrlDecorationStaticPlugin = createSlatePlugin({
	key: "urlDecoration",
	decorate: decorateUrls,
	node: { isLeaf: true, component: UrlLeafStatic },
});

/** Live editor plugins, without collaboration (the editor adds Yjs per document). */
export const columnEditorPlugins = [
	H1Plugin.configure({ inputRules: [HeadingRules.markdown()] }).withComponent(H1Element),
	H2Plugin.configure({ inputRules: [HeadingRules.markdown()] }).withComponent(H2Element),
	H3Plugin.configure({ inputRules: [HeadingRules.markdown()] }).withComponent(H3Element),
	ListPlugin.configure({
		inputRules: [
			BulletedListRules.markdown({ variant: "-" }),
			BulletedListRules.markdown({ variant: "*" }),
			OrderedListRules.markdown({ variant: "." }),
			OrderedListRules.markdown({ variant: ")" }),
			TaskListRules.markdown({ checked: false }),
			TaskListRules.markdown({ checked: true }),
		],
		inject: { targetPlugins: BLOCK_TARGETS },
		render: { belowNodes: BlockList },
	}),
	IndentPlugin.configure({
		inject: { targetPlugins: BLOCK_TARGETS },
		options: { offset: INDENT_OFFSET },
	}),
	ListShortcutsPlugin,
	UrlDecorationPlugin,
];

/** Static counterparts for snapshots. */
export const columnSnapshotPlugins = [
	BaseH1Plugin.withComponent(H1ElementStatic),
	BaseH2Plugin.withComponent(H2ElementStatic),
	BaseH3Plugin.withComponent(H3ElementStatic),
	BaseListPlugin.configure({
		inject: { targetPlugins: BLOCK_TARGETS },
		render: { belowNodes: BlockListStatic },
	}),
	BaseIndentPlugin.configure({
		inject: { targetPlugins: BLOCK_TARGETS },
		options: { offset: INDENT_OFFSET },
	}),
	UrlDecorationStaticPlugin,
];

export { findUrlAtOffset, normalizeUrl };
