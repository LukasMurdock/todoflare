import * as Y from "yjs";

/**
 * A column's content as agents see it. The editor's model is flat: every
 * top-level block is a paragraph or heading, optionally rendered as a list
 * item through `listStyleType` and `indent` (Plate indent lists). Text has no
 * marks; URLs are decorations, not nodes.
 */
export const BLOCK_TYPES = ["p", "h1", "h2", "h3"] as const;
export const LIST_STYLES = ["disc", "decimal", "todo"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export type ListStyle = (typeof LIST_STYLES)[number];

export interface ColumnBlock {
	/** Plate's stable node ID; null for blocks no editor has normalized yet. */
	id: string | null;
	type: BlockType;
	list: ListStyle | null;
	/** Nesting depth from zero; list items start at zero. */
	depth: number;
	/** Only meaningful for todo items. */
	checked: boolean;
	text: string;
}

export interface ColumnContent {
	blocks: ColumnBlock[];
	/** Changes whenever any block's content, kind or order changes. */
	version: string;
}

/** The shared type slate-yjs binds the editor to. */
export function columnContentRoot(doc: Y.Doc): Y.XmlText {
	return doc.get("content", Y.XmlText) as Y.XmlText;
}

function asBlockType(value: unknown): BlockType {
	return BLOCK_TYPES.includes(value as BlockType) ? (value as BlockType) : "p";
}

function asListStyle(value: unknown): ListStyle | null {
	return LIST_STYLES.includes(value as ListStyle) ? (value as ListStyle) : null;
}

function blockText(element: Y.XmlText): string {
	let text = "";
	for (const op of element.toDelta() as Array<{ insert: unknown }>) {
		if (typeof op.insert === "string") text += op.insert;
		// Inline elements do not exist in this editor; flatten any that appear.
		else if (op.insert instanceof Y.XmlText) text += blockText(op.insert);
	}
	return text;
}

export function readColumnBlocks(doc: Y.Doc): ColumnBlock[] {
	const blocks: ColumnBlock[] = [];
	for (const op of columnContentRoot(doc).toDelta() as Array<{ insert: unknown }>) {
		if (!(op.insert instanceof Y.XmlText)) continue;
		const attributes = op.insert.getAttributes() as Record<string, unknown>;
		const list = asListStyle(attributes.listStyleType);
		const indent = typeof attributes.indent === "number" && attributes.indent > 0 ? Math.floor(attributes.indent) : 0;
		blocks.push({
			id: typeof attributes.id === "string" && attributes.id ? attributes.id : null,
			type: asBlockType(attributes.type),
			list,
			depth: list ? Math.max(indent - 1, 0) : indent,
			checked: list === "todo" && attributes.checked === true,
			text: blockText(op.insert),
		});
	}
	return blocks;
}

/** 64-bit FNV-1a over UTF-16 code units. */
function fnv1a64(text: string): bigint {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash;
}

/**
 * An optimistic-concurrency token, not a security boundary. Synchronous on
 * purpose: a Durable Object can interleave other events at any await, so the
 * check against an agent's expected version and the write it guards must run
 * without yielding.
 */
export function columnContentVersion(blocks: readonly ColumnBlock[]): string {
	const canonical = JSON.stringify(blocks.map((b) => [b.id, b.type, b.list, b.depth, b.checked, b.text]));
	return fnv1a64(canonical).toString(36).padStart(13, "0");
}

export function readColumnContent(doc: Y.Doc): ColumnContent {
	const blocks = readColumnBlocks(doc);
	return { blocks, version: columnContentVersion(blocks) };
}

export function isEmptyBlock(block: ColumnBlock): boolean {
	return block.list === null && block.type === "p" && block.text.trim() === "";
}

/** The first line with text, which is how people name a column. */
export function columnTitle(blocks: readonly ColumnBlock[]): string {
	const first = blocks.find((block) => block.text.trim() !== "")?.text.trim() ?? "";
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * Markdown with each block's ID as a trailing ` ^id` reference, which agents
 * pass back to address an item. Blocks without an ID cannot be addressed.
 */
export function columnBlocksToMarkdown(blocks: readonly ColumnBlock[]): string {
	const lines: string[] = [];
	const ordinals: number[] = [];
	for (const block of blocks) {
		const pad = "  ".repeat(block.depth);
		let prefix = "";
		if (block.type !== "p") prefix = `${"#".repeat(Number(block.type.slice(1)))} `;
		if (block.list === "disc") prefix = "- " + prefix;
		if (block.list === "todo") prefix = `- [${block.checked ? "x" : " "}] ` + prefix;
		if (block.list === "decimal") {
			ordinals.length = block.depth + 1;
			ordinals[block.depth] = (ordinals[block.depth] ?? 0) + 1;
			prefix = `${ordinals[block.depth]}. ` + prefix;
		} else {
			ordinals.length = block.list ? block.depth : 0;
		}
		const ref = block.id ? ` ^${block.id}` : "";
		lines.push(isEmptyBlock(block) ? "" : `${pad}${prefix}${block.text}${ref}`);
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
