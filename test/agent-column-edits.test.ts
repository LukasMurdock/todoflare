import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { columnBlocksToMarkdown, columnContentRoot, readColumnContent } from "../src/server/agent-access/column-content";
import { applyAgentEdit, undoAgentChange, type AgentEdit, type EditOutcome } from "../src/server/agent-access/column-edits";
import { docFromPlate } from "./helpers/plate-doc";

const AGENT = "agent-origin";

function board() {
	return docFromPlate([
		{ id: "title00000", type: "h2", children: [{ text: "Week" }] },
		{ id: "milk000000", type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "Milk" }] },
		{ id: "eggs000000", type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "Eggs" }] },
		{ id: "blank00000", type: "p", children: [{ text: "" }] },
	]);
}

function markdown(doc: Y.Doc) {
	return columnBlocksToMarkdown(readColumnContent(doc).blocks);
}

/** Markdown with generated IDs replaced, for readable expectations. */
function shape(doc: Y.Doc) {
	return markdown(doc).replace(/ \^[A-Za-z0-9_-]{10}/g, (ref) => (/ \^(title|milk|eggs|blank)0+/.test(ref) ? ref.replace(/0+$/, "") : " ^new"));
}

function apply(doc: Y.Doc, edit: AgentEdit) {
	const outcome = applyAgentEdit(doc, edit, AGENT);
	if (!outcome.ok) throw new Error(outcome.failure.message);
	return outcome;
}

function blockXml(doc: Y.Doc, id: string): Y.XmlText {
	for (const op of columnContentRoot(doc).toDelta() as Array<{ insert: unknown }>) {
		if (op.insert instanceof Y.XmlText && op.insert.getAttribute("id") === id) return op.insert;
	}
	throw new Error(`no block ${id}`);
}

describe("agent edits", () => {
	it("appends above trailing blank lines, with fresh Plate IDs", () => {
		const doc = board();
		const outcome = apply(doc, {
			kind: "append",
			afterId: null,
			items: [
				{ text: "Bread", style: "todo" },
				{ text: "Notes", style: "heading3" },
				{ text: "sub", style: "bullet", depth: 1 },
			],
		});
		expect(outcome.itemIds).toHaveLength(3);
		expect(outcome.itemIds.every((id) => /^[A-Za-z0-9_-]{10}$/.test(id))).toBe(true);
		expect(shape(doc)).toBe("## Week ^title\n- [ ] Milk ^milk\n- [x] Eggs ^eggs\n- [ ] Bread ^new\n### Notes ^new\n  - sub ^new");
		expect(outcome.summary).toBe("Added 3 items");
	});

	it("appends after a named item", () => {
		const doc = board();
		apply(doc, { kind: "append", afterId: "milk000000", items: [{ text: "Butter", style: "todo", checked: true }] });
		expect(shape(doc)).toBe("## Week ^title\n- [ ] Milk ^milk\n- [x] Butter ^new\n- [x] Eggs ^eggs");
	});

	it("appends into an empty column", () => {
		const doc = docFromPlate([{ type: "p", children: [{ text: "" }] }]);
		apply(doc, { kind: "append", afterId: null, items: [{ text: "First", style: "paragraph" }] });
		expect(shape(doc)).toBe("First ^new");
		expect(readColumnContent(doc).blocks).toHaveLength(2);
	});

	it("checks off, restyles and retexts an item", () => {
		const doc = board();
		expect(apply(doc, { kind: "update", itemId: "milk000000", changes: { checked: true } }).summary).toBe('Checked "Milk"');
		apply(doc, { kind: "update", itemId: "eggs000000", changes: { style: "bullet", text: "Eggs (dozen)", expectedText: "Eggs" } });
		expect(shape(doc)).toBe("## Week ^title\n- [x] Milk ^milk\n- Eggs (dozen) ^eggs");
		expect(blockXml(doc, "eggs000000").getAttribute("checked")).toBeUndefined();
	});

	it("rewrites only the span of text that changed", () => {
		const doc = board();
		const xml = blockXml(doc, "milk000000");
		const ops: unknown[] = [];
		xml.observe((event) => ops.push(...event.delta));
		apply(doc, { kind: "update", itemId: "milk000000", changes: { text: "Oat Milk", expectedText: "Milk" } });
		expect(ops).toEqual([{ insert: "Oat " }]);
	});

	// The lost update: an agent read "Milk", a person then made it "Milk (oat)",
	// and the agent's whole-text write must not silently delete " (oat)".
	it("refuses a whole-text write based on a stale read", () => {
		const doc = board();
		blockXml(doc, "milk000000").insert(4, " (oat)");
		const outcome = applyAgentEdit(doc, { kind: "update", itemId: "milk000000", changes: { text: "Whole Milk", expectedText: "Milk" } }, AGENT);
		expect(outcome).toMatchObject({ ok: false, failure: { code: "item_changed", currentText: "Milk (oat)" } });
		expect(shape(doc)).toContain("- [ ] Milk (oat) ^milk");
	});

	it("refuses a whole-text write that does not say what it read", () => {
		const doc = board();
		const outcome = applyAgentEdit(doc, { kind: "update", itemId: "milk000000", changes: { text: "x" } }, AGENT);
		expect(outcome).toMatchObject({ ok: false, failure: { code: "invalid_edit" } });
	});

	it("replaces one span of the current text, keeping a person's later typing", () => {
		const doc = board();
		blockXml(doc, "milk000000").insert(4, " (oat)");
		apply(doc, { kind: "update", itemId: "milk000000", changes: { find: "Milk", replaceWith: "Whole Milk" } });
		expect(shape(doc)).toContain("- [ ] Whole Milk (oat) ^milk");
	});

	it.each<[string, Record<string, string>, string]>([
		["text that is no longer there", { find: "Cream", replaceWith: "x" }, "item_changed"],
		["an ambiguous span", { find: "e", replaceWith: "x" }, "invalid_edit"],
		["an empty span", { find: "", replaceWith: "x" }, "invalid_edit"],
		["both kinds of text change", { find: "E", replaceWith: "x", text: "y", expectedText: "Eggs" }, "invalid_edit"],
		["a replacement that adds a line break", { find: "Eggs", replaceWith: "a\nb" }, "invalid_edit"],
	])("refuses %s", (_name, changes, code) => {
		const doc = docFromPlate([{ id: "eggs000000", type: "p", children: [{ text: "Eggs eaten" }] }]);
		const outcome = applyAgentEdit(doc, { kind: "update", itemId: "eggs000000", changes }, AGENT);
		expect(outcome).toMatchObject({ ok: false, failure: { code } });
	});

	it("deletes items and refuses a stale version", () => {
		const doc = board();
		const { version } = readColumnContent(doc);
		const stale = applyAgentEdit(doc, { kind: "delete", itemIds: ["milk000000"], expectedVersion: "0000000000000" }, AGENT);
		expect(stale).toMatchObject({ ok: false, failure: { code: "stale_version", version } });
		apply(doc, { kind: "delete", itemIds: ["milk000000", "eggs000000"], expectedVersion: version });
		expect(shape(doc)).toBe("## Week ^title");
	});

	it("replaces the column, keeping identities it is told to keep", () => {
		const doc = board();
		const { version } = readColumnContent(doc);
		apply(doc, {
			kind: "replace",
			expectedVersion: version,
			items: [
				{ id: "eggs000000", text: "Eggs", style: "todo", checked: true },
				{ id: "milk000000", text: "Milk", style: "todo" },
				{ text: "New", style: "paragraph" },
			],
		});
		expect(shape(doc)).toBe("- [x] Eggs ^eggs\n- [ ] Milk ^milk\nNew ^new");
	});

	it.each<[string, AgentEdit, string]>([
		["unknown item", { kind: "update", itemId: "nope000000", changes: { text: "x", expectedText: "" } }, "item_not_found"],
		["unknown anchor", { kind: "append", afterId: "nope000000", items: [{ text: "x", style: "todo" }] }, "item_not_found"],
		["checking a non-todo", { kind: "update", itemId: "title00000", changes: { checked: true } }, "invalid_edit"],
		["checked on a bullet", { kind: "append", afterId: null, items: [{ text: "x", style: "bullet", checked: true }] }, "invalid_edit"],
		["a repeated ID", { kind: "replace", expectedVersion: "", items: [{ id: "milk000000", text: "a", style: "todo" }, { id: "milk000000", text: "b", style: "todo" }] }, "invalid_edit"],
	])("rejects %s without touching the document", (_name, edit, code) => {
		const doc = board();
		if (edit.kind === "replace") edit.expectedVersion = readColumnContent(doc).version;
		const before = Y.encodeStateVector(doc);
		const outcome = applyAgentEdit(doc, edit, AGENT) as Extract<EditOutcome, { ok: false }>;
		expect(outcome.failure.code).toBe(code);
		expect(Y.encodeStateVector(doc)).toEqual(before);
	});

	it("reports a no-op update as unchanged", () => {
		const doc = board();
		expect(apply(doc, { kind: "update", itemId: "milk000000", changes: { text: "Milk", expectedText: "Milk", checked: false } }).changed).toBe(false);
	});

	it("tags every edit with the agent's transaction origin", () => {
		const doc = board();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction) => origins.push(transaction.origin));
		apply(doc, { kind: "append", afterId: null, items: [{ text: "x", style: "todo" }] });
		expect(origins).toEqual([AGENT]);
	});
});

describe("undoing agent edits", () => {
	it.each<[string, AgentEdit]>([
		["an append", { kind: "append", afterId: "milk000000", items: [{ text: "A", style: "todo" }, { text: "B", style: "bullet" }] }],
		["a check", { kind: "update", itemId: "milk000000", changes: { checked: true } }],
		["a restyle and retext", { kind: "update", itemId: "eggs000000", changes: { style: "heading1", text: "EGGS", expectedText: "Eggs" } }],
		["a find and replace", { kind: "update", itemId: "eggs000000", changes: { find: "gg", replaceWith: "GG" } }],
		["a delete", { kind: "delete", itemIds: ["milk000000", "eggs000000"], expectedVersion: "" }],
		["a delete of the first item", { kind: "delete", itemIds: ["title00000"], expectedVersion: "" }],
		["a replace", { kind: "replace", expectedVersion: "", items: [{ text: "only", style: "paragraph" }] }],
	])("restores the exact prior content after %s", (_name, edit) => {
		const doc = board();
		const before = readColumnContent(doc);
		if ("expectedVersion" in edit && edit.expectedVersion === "") edit.expectedVersion = before.version;
		const outcome = apply(doc, edit);
		expect(readColumnContent(doc).version).not.toBe(before.version);
		const undone = undoAgentChange(doc, outcome.undo, "undo");
		expect(undone).toMatchObject({ kept: 0, version: before.version });
		expect(readColumnContent(doc).blocks).toEqual(before.blocks);
	});

	it("keeps an appended item a person has since edited", () => {
		const doc = board();
		const { undo, itemIds } = apply(doc, { kind: "append", afterId: null, items: [{ text: "Agent", style: "todo" }, { text: "Other", style: "todo" }] });
		blockXml(doc, itemIds[0]!).insert(5, " + human");
		expect(undoAgentChange(doc, undo, "undo")).toMatchObject({ restored: 1, kept: 1 });
		expect(shape(doc)).toContain("Agent + human");
		expect(shape(doc)).not.toContain("Other");
	});

	it("reverts only the fields a person has not touched since", () => {
		const doc = board();
		const { undo } = apply(doc, { kind: "update", itemId: "milk000000", changes: { text: "Oat milk", expectedText: "Milk", checked: true } });
		blockXml(doc, "milk000000").setAttribute("checked", false); // A person unchecks it again.
		expect(undoAgentChange(doc, undo, "undo")).toMatchObject({ restored: 1, kept: 1 });
		expect(shape(doc)).toContain("- [ ] Milk ^milk");
	});

	it("keeps a person's later edits to text the agent rewrote", () => {
		const doc = board();
		const { undo } = apply(doc, { kind: "update", itemId: "milk000000", changes: { text: "Oat milk", expectedText: "Milk" } });
		blockXml(doc, "milk000000").insert(8, "!");
		expect(undoAgentChange(doc, undo, "undo")).toMatchObject({ restored: 0, kept: 1 });
		expect(shape(doc)).toContain("Oat milk!");
	});

	it("does not resurrect an item twice", () => {
		const doc = board();
		const { undo } = apply(doc, { kind: "delete", itemIds: ["milk000000"], expectedVersion: readColumnContent(doc).version });
		undoAgentChange(doc, undo, "undo");
		expect(undoAgentChange(doc, undo, "undo")).toMatchObject({ restored: 0, kept: 1 });
		expect(markdown(doc).match(/\^milk000000/g)).toHaveLength(1);
	});

	it("leaves a replaced column alone once a person has edited it", () => {
		const doc = board();
		const { undo, itemIds } = apply(doc, { kind: "replace", expectedVersion: readColumnContent(doc).version, items: [{ text: "only", style: "paragraph" }] });
		blockXml(doc, itemIds[0]!).insert(4, " mine");
		expect(undoAgentChange(doc, undo, "undo")).toMatchObject({ restored: 0, kept: 1 });
		expect(shape(doc)).toBe("only mine ^new");
	});

	it("survives a round trip through stored JSON", () => {
		const doc = board();
		const { undo } = apply(doc, { kind: "delete", itemIds: ["eggs000000"], expectedVersion: readColumnContent(doc).version });
		const reloaded = new Y.Doc();
		Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
		undoAgentChange(reloaded, JSON.parse(JSON.stringify(undo)), "undo");
		expect(shape(reloaded)).toBe("## Week ^title\n- [ ] Milk ^milk\n- [x] Eggs ^eggs");
	});
});
