import * as Y from "yjs";
import { AGENT_ITEM_STYLES } from "../../lib/api/agent-contract";
import { columnContentRoot, readColumnContent } from "./column-content";

/**
 * Agent edits to one column's Yjs document, and their undo.
 *
 * Edits are applied as ordinary Yjs operations, exactly as the editor's
 * slate-yjs binding would make them, so they merge with concurrent typing.
 *
 * Undo is compare-and-revert, never a blind rollback: each change records what
 * the agent wrote, and undo reverts a field or item only while it still holds
 * the agent's value. Anything a person changed since is kept. (True Yjs undo is
 * not durable: garbage collection discards deleted content once the Durable
 * Object reloads.)
 */

/** The item styles agents name; the same list people see in change diffs. */
export const ITEM_STYLES = AGENT_ITEM_STYLES;
export type ItemStyle = (typeof ITEM_STYLES)[number];

export interface NewItem {
	text: string;
	style: ItemStyle;
	/** Todo items only. */
	checked?: boolean;
	depth?: number;
	/** replace only: keep an existing item's identity, e.g. when reordering. */
	id?: string;
}

/**
 * Text changes never overwrite someone else's work blindly. Either replace
 * one exact span of the current text (`find`/`replaceWith`, which rebases onto
 * concurrent edits), or set the whole text while stating what it was read as
 * (`text`/`expectedText`, refused if it has changed since).
 */
export interface ItemChanges {
	text?: string;
	expectedText?: string;
	find?: string;
	replaceWith?: string;
	style?: ItemStyle;
	checked?: boolean;
	depth?: number;
}

export type AgentEdit =
	| { kind: "append"; items: NewItem[]; afterId: string | null }
	| { kind: "update"; itemId: string; changes: ItemChanges; expectedVersion?: string }
	| { kind: "delete"; itemIds: string[]; expectedVersion: string }
	| { kind: "replace"; items: NewItem[]; expectedVersion: string };

/** The block attributes the editor reads, plus the block's text. */
const FIELDS = ["type", "listStyleType", "indent", "checked", "listStart", "text"] as const;
type Field = (typeof FIELDS)[number];
export type FieldValues = Partial<Record<Field, unknown>>;

/** A whole block as Plate stores it, enough to recreate it exactly. */
export interface BlockSnapshot {
	attributes: Record<string, unknown>;
	runs: Array<{ insert: string; attributes?: Record<string, unknown> }>;
}

export type UndoRecord =
	| { kind: "remove-inserted"; items: Array<{ id: string; written: FieldValues }> }
	| {
			kind: "restore-fields";
			id: string;
			before: FieldValues;
			after: FieldValues;
			/** Every field of the item before the change, to show it in context. Absent from older records. */
			context?: FieldValues;
		}
	| { kind: "reinsert"; items: Array<{ snapshot: BlockSnapshot; afterId: string | null; index: number }> }
	| { kind: "restore-column"; before: BlockSnapshot[]; after: Array<FieldValues & { id: string }> };

export type EditFailure =
	| { code: "stale_version"; message: string; version: string }
	| { code: "item_changed"; message: string; currentText: string }
	| { code: "item_not_found"; message: string }
	| { code: "invalid_edit"; message: string };

export type EditOutcome =
	| { ok: true; version: string; itemIds: string[]; summary: string; undo: UndoRecord; changed: boolean }
	| { ok: false; failure: EditFailure };

export interface UndoOutcome {
	/** Fields or items put back. */
	restored: number;
	/** Fields or items left alone because someone changed them after the agent. */
	kept: number;
	version: string;
}

export const MAX_COLUMN_BLOCKS = 2000;
export const MAX_ITEM_TEXT = 2000;
const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

interface BlockEntry {
	xml: Y.XmlText;
	offset: number;
	id: string | null;
}

function blockEntries(doc: Y.Doc): BlockEntry[] {
	const entries: BlockEntry[] = [];
	let offset = 0;
	for (const op of columnContentRoot(doc).toDelta() as Array<{ insert: unknown }>) {
		if (op.insert instanceof Y.XmlText) {
			const id = op.insert.getAttribute("id");
			entries.push({ xml: op.insert, offset, id: typeof id === "string" && id ? id : null });
			offset += 1;
		} else if (typeof op.insert === "string") {
			offset += op.insert.length;
		}
	}
	return entries;
}

function plainText(xml: Y.XmlText): string {
	return (xml.toDelta() as Array<{ insert: unknown }>).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

function fieldValues(xml: Y.XmlText): FieldValues {
	const attributes = xml.getAttributes() as Record<string, unknown>;
	const values: FieldValues = {};
	for (const field of FIELDS) values[field] = field === "text" ? plainText(xml) : attributes[field];
	return values;
}

function sameValue(left: unknown, right: unknown): boolean {
	return left === right || (left === undefined && right === null) || (left === null && right === undefined);
}

/** Every item's current fields, by ID. */
export function currentItemFields(doc: Y.Doc): Map<string, FieldValues> {
	const items = new Map<string, FieldValues>();
	for (const entry of blockEntries(doc)) if (entry.id) items.set(entry.id, fieldValues(entry.xml));
	return items;
}

function snapshot(xml: Y.XmlText): BlockSnapshot {
	return {
		attributes: { ...(xml.getAttributes() as Record<string, unknown>) },
		runs: (xml.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>)
			.filter((op): op is { insert: string; attributes?: Record<string, unknown> } => typeof op.insert === "string")
			.map((op) => (op.attributes ? { insert: op.insert, attributes: op.attributes } : { insert: op.insert })),
	};
}

function blockFromSnapshot(saved: BlockSnapshot): Y.XmlText {
	const xml = new Y.XmlText();
	for (const [key, value] of Object.entries(saved.attributes)) xml.setAttribute(key, value as never);
	xml.applyDelta(saved.runs, { sanitize: false });
	return xml;
}

/** The attributes Plate uses for each item style, with null meaning "absent". */
function styleAttributes(style: ItemStyle, depth: number, checked: boolean): Record<string, unknown> {
	const list = { todo: "todo", bullet: "disc", numbered: "decimal" }[style as "todo" | "bullet" | "numbered"];
	const heading = { heading1: "h1", heading2: "h2", heading3: "h3" }[style as "heading1" | "heading2" | "heading3"];
	return {
		type: heading ?? "p",
		listStyleType: list ?? null,
		// Plate indent lists start list items at indent 1.
		indent: list ? depth + 1 : depth > 0 ? depth : null,
		checked: style === "todo" ? checked : null,
		listStart: null,
	};
}

export function currentStyle(values: FieldValues): { style: ItemStyle; depth: number; checked: boolean } {
	const list = values.listStyleType;
	const indent = typeof values.indent === "number" ? values.indent : 0;
	const style: ItemStyle =
		list === "todo" ? "todo" : list === "disc" ? "bullet" : list === "decimal" ? "numbered"
			: values.type === "h1" ? "heading1" : values.type === "h2" ? "heading2" : values.type === "h3" ? "heading3" : "paragraph";
	return { style, depth: list ? Math.max(indent - 1, 0) : indent, checked: values.checked === true };
}

function setAttributes(xml: Y.XmlText, attributes: Record<string, unknown>) {
	for (const [key, value] of Object.entries(attributes)) {
		if (value === null || value === undefined) {
			if (xml.getAttribute(key) !== undefined) xml.removeAttribute(key);
		} else if (xml.getAttribute(key) !== value) {
			xml.setAttribute(key, value as never);
		}
	}
}

/**
 * Rewrites a block's text by replacing only the span that differs, so
 * concurrent typing elsewhere in the same block survives the merge.
 */
function setText(xml: Y.XmlText, next: string) {
	const current = plainText(xml);
	if (current === next) return;
	let start = 0;
	while (start < current.length && start < next.length && current[start] === next[start]) start++;
	let end = 0;
	while (
		end < current.length - start &&
		end < next.length - start &&
		current[current.length - 1 - end] === next[next.length - 1 - end]
	) end++;
	const removed = current.length - start - end;
	if (removed > 0) xml.delete(start, removed);
	const inserted = next.slice(start, next.length - end);
	if (inserted) xml.insert(start, inserted);
}

function newId(taken: Set<string>): string {
	for (;;) {
		const bytes = crypto.getRandomValues(new Uint8Array(10));
		const id = Array.from(bytes, (byte) => ID_ALPHABET[byte & 63]).join("");
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}

/**
 * A new block, not yet in any document. Yjs forbids reading a type before it
 * is integrated, so attributes are only set here, never compared.
 */
function createBlock(item: NewItem, id: string): Y.XmlText {
	const xml = new Y.XmlText();
	for (const [key, value] of Object.entries({ id, ...styleAttributes(item.style, item.depth ?? 0, item.checked ?? false) })) {
		if (value !== null) xml.setAttribute(key, value as never);
	}
	if (item.text) xml.insert(0, item.text);
	return xml;
}

function validateItem(item: NewItem): EditFailure | null {
	if (item.checked !== undefined && item.style !== "todo") {
		return { code: "invalid_edit", message: "Only todo items can be checked." };
	}
	return null;
}

function failure(failure: EditFailure): EditOutcome {
	return { ok: false, failure };
}

function staleVersion(version: string): EditOutcome {
	return failure({
		code: "stale_version",
		message: `The column changed since it was read (now version ${version}). Read it again before retrying.`,
		version,
	});
}

function quote(text: string): string {
	return text.length > 40 ? `"${text.slice(0, 39)}…"` : `"${text}"`;
}

/** Applies one agent edit in a single transaction tagged with `origin`. */
export function applyAgentEdit(doc: Y.Doc, edit: AgentEdit, origin: unknown): EditOutcome {
	const { version } = readColumnContent(doc);
	if ("expectedVersion" in edit && edit.expectedVersion !== undefined && edit.expectedVersion !== version) {
		return staleVersion(version);
	}
	const entries = blockEntries(doc);
	const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
	const missing = (id: string) => failure({ code: "item_not_found", message: `No item ^${id} in this column. Read the column again for current IDs.` });
	const root = columnContentRoot(doc);

	switch (edit.kind) {
		case "append": {
			for (const item of edit.items) {
				const invalid = validateItem(item);
				if (invalid) return failure(invalid);
			}
			if (entries.length + edit.items.length > MAX_COLUMN_BLOCKS) {
				return failure({ code: "invalid_edit", message: `A column holds at most ${MAX_COLUMN_BLOCKS} items.` });
			}
			let at: number;
			if (edit.afterId !== null) {
				const after = byId.get(edit.afterId);
				if (!after) return missing(edit.afterId);
				at = after.offset + 1;
			} else {
				// Land above trailing blank lines, where a person would type next.
				let last = entries.length;
				while (last > 0 && plainText(entries[last - 1]!.xml) === "" && fieldValues(entries[last - 1]!.xml).listStyleType == null) last--;
				at = last < entries.length ? entries[last]!.offset : root.length;
			}
			const taken = new Set(byId.keys());
			const ids = edit.items.map(() => newId(taken));
			const blocks = edit.items.map((item, index) => createBlock(item, ids[index]!));
			doc.transact(() => {
				root.applyDelta([...(at > 0 ? [{ retain: at }] : []), ...blocks.map((block) => ({ insert: block }))], { sanitize: false });
			}, origin);
			return {
				ok: true,
				changed: true,
				version: readColumnContent(doc).version,
				itemIds: ids,
				summary: edit.items.length === 1 ? `Added ${quote(edit.items[0]!.text)}` : `Added ${edit.items.length} items`,
				undo: { kind: "remove-inserted", items: blocks.map((block, index) => ({ id: ids[index]!, written: fieldValues(block) })) },
			};
		}

		case "update": {
			const entry = byId.get(edit.itemId);
			if (!entry) return missing(edit.itemId);
			const before = fieldValues(entry.xml);
			const current = currentStyle(before);
			const { text: wholeText, expectedText, find, replaceWith } = edit.changes;
			const currentText = String(before.text);
			let nextText: string | undefined;
			if (wholeText !== undefined && find !== undefined) {
				return failure({ code: "invalid_edit", message: "Give either text or find/replaceWith, not both." });
			}
			if (wholeText !== undefined) {
				if (expectedText === undefined) {
					return failure({ code: "invalid_edit", message: "Setting the whole text needs expectedText: the item's text as you read it." });
				}
				if (expectedText !== currentText) {
					return failure({
						code: "item_changed",
						message: `The item changed since it was read. Its text is now: ${JSON.stringify(currentText)}. Use find/replaceWith to change just part of it, or retry with the new text as expectedText.`,
						currentText,
					});
				}
				nextText = wholeText;
			} else if (find !== undefined || replaceWith !== undefined) {
				if (!find || replaceWith === undefined) return failure({ code: "invalid_edit", message: "find and replaceWith go together, and find cannot be empty." });
				const at = currentText.indexOf(find);
				if (at === -1) {
					return failure({ code: "item_changed", message: `${JSON.stringify(find)} is not in the item. Its text is now: ${JSON.stringify(currentText)}.`, currentText });
				}
				if (currentText.indexOf(find, at + 1) !== -1) {
					return failure({ code: "invalid_edit", message: `${JSON.stringify(find)} appears more than once in the item; include more surrounding text.` });
				}
				nextText = currentText.slice(0, at) + replaceWith + currentText.slice(at + find.length);
			}
			if (nextText !== undefined && (/[\r\n]/.test(nextText) || nextText.length > MAX_ITEM_TEXT)) {
				return failure({ code: "invalid_edit", message: `An item is one line of at most ${MAX_ITEM_TEXT} characters.` });
			}
			const style = edit.changes.style ?? current.style;
			if (edit.changes.checked !== undefined && style !== "todo") {
				return failure({ code: "invalid_edit", message: "Only todo items can be checked." });
			}
			const target: FieldValues = {
				...(edit.changes.style !== undefined || edit.changes.depth !== undefined || edit.changes.checked !== undefined
					? styleAttributes(style, edit.changes.depth ?? current.depth, edit.changes.checked ?? (style === "todo" ? current.checked : false))
					: {}),
				...(nextText !== undefined ? { text: nextText } : {}),
			};
			// A numbered list's start only matters while it stays numbered at the same place.
			if (edit.changes.style === undefined || edit.changes.style === current.style) delete target.listStart;
			const changed = (Object.keys(target) as Field[]).filter((field) => !sameValue(before[field], target[field]));
			if (changed.length === 0) {
				return {
					ok: true,
					changed: false,
					version: readColumnContent(doc).version,
					itemIds: [edit.itemId],
					summary: `No change to ${quote(String(before.text))}`,
					undo: { kind: "restore-fields", id: edit.itemId, before: {}, after: {} },
				};
			}
			doc.transact(() => {
				const { text, ...attributes } = Object.fromEntries(changed.map((field) => [field, target[field]]));
				setAttributes(entry.xml, attributes);
				if (text !== undefined) setText(entry.xml, String(text));
			}, origin);
			const after = fieldValues(entry.xml);
			const onlyChecked = changed.length === 1 && changed[0] === "checked";
			return {
				ok: true,
				changed: true,
				version: readColumnContent(doc).version,
				itemIds: [edit.itemId],
				summary: onlyChecked ? `${after.checked ? "Checked" : "Unchecked"} ${quote(String(after.text))}` : `Edited ${quote(String(after.text))}`,
				undo: {
					kind: "restore-fields",
					id: edit.itemId,
					context: before,
					before: Object.fromEntries(changed.map((field) => [field, before[field] ?? null])),
					after: Object.fromEntries(changed.map((field) => [field, after[field] ?? null])),
				},
			};
		}

		case "delete": {
			const unique = [...new Set(edit.itemIds)];
			const targets = unique.map((id) => byId.get(id));
			const absent = unique.find((_id, index) => !targets[index]);
			if (absent) return missing(absent);
			const items = (targets as BlockEntry[])
				.sort((left, right) => left.offset - right.offset)
				.map((entry) => {
					const index = entries.indexOf(entry);
					// Anchor to the nearest item above, even one deleted in this same
					// change: undo reinserts in order, so a deleted run rebuilds itself.
					let anchor: string | null = null;
					for (let previous = index - 1; previous >= 0; previous--) {
						const candidate = entries[previous]!;
						if (candidate.id) {
							anchor = candidate.id;
							break;
						}
					}
					return { snapshot: snapshot(entry.xml), afterId: anchor, index };
				});
			doc.transact(() => {
				for (const entry of [...(targets as BlockEntry[])].sort((left, right) => right.offset - left.offset)) root.delete(entry.offset, 1);
			}, origin);
			return {
				ok: true,
				changed: true,
				version: readColumnContent(doc).version,
				itemIds: unique,
				summary: unique.length === 1 ? `Deleted ${quote(items[0]!.snapshot.runs.map((run) => run.insert).join(""))}` : `Deleted ${unique.length} items`,
				undo: { kind: "reinsert", items },
			};
		}

		case "replace": {
			for (const item of edit.items) {
				const invalid = validateItem(item);
				if (invalid) return failure(invalid);
			}
			if (edit.items.length > MAX_COLUMN_BLOCKS) {
				return failure({ code: "invalid_edit", message: `A column holds at most ${MAX_COLUMN_BLOCKS} items.` });
			}
			const kept = edit.items.map((item) => item.id).filter((id): id is string => id !== undefined);
			if (new Set(kept).size !== kept.length) return failure({ code: "invalid_edit", message: "Each item ID may appear only once." });
			const unknown = kept.find((id) => !byId.has(id));
			if (unknown) return missing(unknown);
			const before = entries.map((entry) => snapshot(entry.xml));
			const taken = new Set(byId.keys());
			const blocks = edit.items.map((item) => createBlock(item, item.id ?? newId(taken)));
			doc.transact(() => {
				if (root.length > 0) root.delete(0, root.length);
				root.applyDelta(blocks.map((block) => ({ insert: block })), { sanitize: false });
			}, origin);
			const after = blocks.map((block) => ({ id: String(block.getAttribute("id")), ...fieldValues(block) }));
			return {
				ok: true,
				changed: true,
				version: readColumnContent(doc).version,
				itemIds: after.map((item) => item.id),
				summary: `Rewrote the column (${edit.items.length} items)`,
				undo: { kind: "restore-column", before, after },
			};
		}
	}
}

/** Reverts what an agent change wrote, wherever it is still what the agent left. */
export function undoAgentChange(doc: Y.Doc, record: UndoRecord, origin: unknown): UndoOutcome {
	let restored = 0;
	let kept = 0;
	const root = columnContentRoot(doc);

	doc.transact(() => {
		const entries = blockEntries(doc);
		const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));

		switch (record.kind) {
			case "remove-inserted": {
				const removable = record.items
					.map(({ id, written }) => ({ entry: byId.get(id), written }))
					.filter(({ entry, written }) => {
						if (!entry) return false; // Already gone: nothing to undo.
						const now = fieldValues(entry.xml);
						const untouched = FIELDS.every((field) => sameValue(now[field], written[field]));
						if (!untouched) kept++;
						return untouched;
					})
					.map(({ entry }) => entry!);
				for (const entry of removable.sort((left, right) => right.offset - left.offset)) {
					root.delete(entry.offset, 1);
					restored++;
				}
				break;
			}

			case "restore-fields": {
				const entry = byId.get(record.id);
				const fields = Object.keys(record.after) as Field[];
				if (!entry) {
					kept += fields.length;
					break;
				}
				const now = fieldValues(entry.xml);
				const revert: FieldValues = {};
				for (const field of fields) {
					if (sameValue(now[field], record.after[field])) {
						revert[field] = record.before[field];
						restored++;
					} else {
						kept++;
					}
				}
				const { text, ...attributes } = revert;
				setAttributes(entry.xml, attributes);
				if (text !== undefined) setText(entry.xml, String(text ?? ""));
				break;
			}

			case "reinsert": {
				for (const item of record.items) {
					const id = item.snapshot.attributes.id;
					const current = blockEntries(doc);
					if (typeof id === "string" && current.some((entry) => entry.id === id)) {
						kept++; // Someone already brought it back.
						continue;
					}
					const anchor = item.afterId ? current.find((entry) => entry.id === item.afterId) : undefined;
					// Without a surviving anchor (it was first, or everything above it is
					// gone or has no ID yet), fall back to its old position.
					const offset = anchor ? anchor.offset + 1 : (current[Math.min(item.index, current.length)]?.offset ?? root.length);
					root.applyDelta([...(offset > 0 ? [{ retain: offset }] : []), { insert: blockFromSnapshot(item.snapshot) }], { sanitize: false });
					restored++;
				}
				break;
			}

			case "restore-column": {
				const now = entries.map((entry) => ({ id: entry.id, ...fieldValues(entry.xml) }));
				const untouched =
					now.length === record.after.length &&
					now.every((block, index) => {
						const written = record.after[index]!;
						return block.id === written.id && FIELDS.every((field) => sameValue(block[field], written[field]));
					});
				if (!untouched) {
					kept++;
					break;
				}
				if (root.length > 0) root.delete(0, root.length);
				root.applyDelta(record.before.map((saved) => ({ insert: blockFromSnapshot(saved) })), { sanitize: false });
				restored++;
				break;
			}
		}
	}, origin);

	return { restored, kept, version: readColumnContent(doc).version };
}
