import { describe, expect, it } from "vitest";
import { textChange } from "../src/lib/agents/text-change";
import { describeAgentChange, MAX_DIFF_ENTRIES } from "../src/server/agent-access/change-diff";

const todo = (text: string, checked = false) => ({ type: "p", listStyleType: "todo", indent: 1, checked, text });
const snapshot = (id: string | null, text: string, attributes: Record<string, unknown> = {}) => ({
	attributes: { ...(id ? { id } : {}), type: "p", ...attributes },
	runs: [{ insert: text }],
});
const none = () => undefined;

describe("describeAgentChange", () => {
	it("shows added items", () => {
		expect(describeAgentChange({ kind: "remove-inserted", items: [{ id: "a", written: todo("Bread") }] }, none)).toEqual({
			entries: [{ kind: "added", item: { text: "Bread", style: "todo", checked: false, depth: 0 } }],
			omitted: 0,
		});
	});

	it("shows removed items from their saved copies", () => {
		const diff = describeAgentChange(
			{ kind: "reinsert", items: [{ snapshot: snapshot("a", "Old note", { listStyleType: "disc", indent: 2 }), afterId: null, index: 0 }] },
			none,
		);
		expect(diff.entries).toEqual([{ kind: "removed", item: { text: "Old note", style: "bullet", checked: false, depth: 1 } }]);
	});

	it("shows an edited item with the fields the change left alone", () => {
		const diff = describeAgentChange(
			{ kind: "restore-fields", id: "m", context: todo("Milk"), before: { checked: false }, after: { checked: true } },
			none,
		);
		expect(diff.entries).toEqual([
			{ kind: "changed", before: { text: "Milk", style: "todo", checked: false, depth: 0 }, after: { text: "Milk", style: "todo", checked: true, depth: 0 } },
		]);
	});

	it("borrows the item's current fields for records saved before context existed", () => {
		const diff = describeAgentChange({ kind: "restore-fields", id: "m", before: { text: "Milk" }, after: { text: "Oat milk" } }, (id) =>
			id === "m" ? todo("Oat milk", true) : undefined,
		);
		expect(diff.entries).toEqual([
			{ kind: "changed", before: { text: "Milk", style: "todo", checked: true, depth: 0 }, after: { text: "Oat milk", style: "todo", checked: true, depth: 0 } },
		]);
	});

	it("shows nothing for a change that changed nothing", () => {
		expect(describeAgentChange({ kind: "restore-fields", id: "m", before: {}, after: {} }, none)).toEqual({ entries: [], omitted: 0 });
	});

	it("compares a rewrite item by item, by identity", () => {
		const diff = describeAgentChange(
			{
				kind: "restore-column",
				before: [snapshot("keep", "Same"), snapshot("edit", "Before"), snapshot("gone", "Removed"), snapshot(null, "No id")],
				after: [
					{ id: "keep", type: "p", text: "Same" },
					{ id: "edit", type: "p", text: "After" },
					{ id: "new", type: "p", text: "Added" },
				],
			},
			none,
		);
		const paragraph = (text: string) => ({ text, style: "paragraph", checked: false, depth: 0 });
		expect(diff.entries).toEqual([
			{ kind: "changed", before: paragraph("Before"), after: paragraph("After") },
			{ kind: "added", item: paragraph("Added") },
			{ kind: "removed", item: paragraph("Removed") },
			{ kind: "removed", item: paragraph("No id") },
		]);
	});

	it("lists a record it cannot read with no diff rather than failing", () => {
		expect(describeAgentChange({} as never, none)).toEqual({ entries: [], omitted: 0 });
		expect(describeAgentChange({ kind: "reinsert", items: null } as never, none)).toEqual({ entries: [], omitted: 0 });
	});

	it("keeps long diffs short and says how much it left out", () => {
		const items = Array.from({ length: MAX_DIFF_ENTRIES + 7 }, (_, index) => ({ id: `i${index}`, written: todo(`Item ${index}`) }));
		const diff = describeAgentChange({ kind: "remove-inserted", items }, none);
		expect(diff.entries).toHaveLength(MAX_DIFF_ENTRIES);
		expect(diff.omitted).toBe(7);
	});
});

describe("textChange", () => {
	it("isolates the words that differ", () => {
		expect(textChange("Buy milk today", "Buy oat milk today")).toEqual({ prefix: "Buy ", removed: "", added: "oat ", suffix: "milk today" });
		expect(textChange("Call mum", "Call dad")).toEqual({ prefix: "Call ", removed: "mum", added: "dad", suffix: "" });
		expect(textChange("Same", "Same")).toEqual({ prefix: "Same", removed: "", added: "", suffix: "" });
		expect(textChange("", "New")).toEqual({ prefix: "", removed: "", added: "New", suffix: "" });
	});
});
