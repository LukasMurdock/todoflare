import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
	columnBlocksToMarkdown,
	columnContentRoot,
	columnTitle,
	readColumnBlocks,
	readColumnContent,
} from "../src/server/agent-access/column-content";
import { docFromPlate } from "./helpers/plate-doc";

const BOARD = [
	{ id: "h1aaaaaaaa", type: "h1", children: [{ text: "Groceries" }] },
	{ id: "td1aaaaaaa", type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "Milk" }] },
	{ id: "td2aaaaaaa", type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "Eggs" }] },
	{ id: "td3aaaaaaa", type: "p", listStyleType: "todo", indent: 2, children: [{ text: "Free range" }] },
	{ id: "emptyaaaaa", type: "p", children: [{ text: "" }] },
	{ id: "ol1aaaaaaa", type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "First" }] },
	{ id: "ol2aaaaaaa", type: "p", listStyleType: "decimal", indent: 1, listStart: 2, children: [{ text: "Second" }] },
	{ id: "ulaaaaaaaa", type: "p", listStyleType: "disc", indent: 1, children: [{ text: "See " }, { text: "example.com", bold: true }] },
	{ type: "p", children: [{ text: "Never normalized" }] },
];

describe("column content codec", () => {
	it("reads the editor's flat block model", () => {
		expect(readColumnBlocks(docFromPlate(BOARD))).toEqual([
			{ id: "h1aaaaaaaa", type: "h1", list: null, depth: 0, checked: false, text: "Groceries" },
			{ id: "td1aaaaaaa", type: "p", list: "todo", depth: 0, checked: false, text: "Milk" },
			{ id: "td2aaaaaaa", type: "p", list: "todo", depth: 0, checked: true, text: "Eggs" },
			{ id: "td3aaaaaaa", type: "p", list: "todo", depth: 1, checked: false, text: "Free range" },
			{ id: "emptyaaaaa", type: "p", list: null, depth: 0, checked: false, text: "" },
			{ id: "ol1aaaaaaa", type: "p", list: "decimal", depth: 0, checked: false, text: "First" },
			{ id: "ol2aaaaaaa", type: "p", list: "decimal", depth: 0, checked: false, text: "Second" },
			{ id: "ulaaaaaaaa", type: "p", list: "disc", depth: 0, checked: false, text: "See example.com" },
			{ id: null, type: "p", list: null, depth: 0, checked: false, text: "Never normalized" },
		]);
	});

	it("renders markdown with addressable block references", () => {
		expect(columnBlocksToMarkdown(readColumnBlocks(docFromPlate(BOARD)))).toBe(
			[
				"# Groceries ^h1aaaaaaaa",
				"- [ ] Milk ^td1aaaaaaa",
				"- [x] Eggs ^td2aaaaaaa",
				"  - [ ] Free range ^td3aaaaaaa",
				"",
				"1. First ^ol1aaaaaaa",
				"2. Second ^ol2aaaaaaa",
				"- See example.com ^ulaaaaaaaa",
				"Never normalized",
			].join("\n"),
		);
	});

	it("restarts numbering after an interruption", () => {
		const blocks = readColumnBlocks(
			docFromPlate([
				{ id: "a", type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "one" }] },
				{ id: "b", type: "p", children: [{ text: "break" }] },
				{ id: "c", type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "one again" }] },
			]),
		);
		expect(columnBlocksToMarkdown(blocks)).toBe("1. one ^a\nbreak ^b\n1. one again ^c");
	});

	it("names a column by its first line of text", () => {
		expect(columnTitle(readColumnBlocks(docFromPlate(BOARD)))).toBe("Groceries");
		expect(columnTitle(readColumnBlocks(new Y.Doc()))).toBe("");
		expect(columnTitle([{ id: null, type: "p", list: null, depth: 0, checked: false, text: "x".repeat(200) }])).toHaveLength(80);
	});

	it("versions content: stable across encodings, different after any edit", async () => {
		const original = docFromPlate(BOARD);
		const copy = new Y.Doc();
		Y.applyUpdate(copy, Y.encodeStateAsUpdate(original));
		const before = (await readColumnContent(original)).version;
		expect((await readColumnContent(copy)).version).toBe(before);

		const firstTodo = columnContentRoot(copy).toDelta()[1].insert as Y.XmlText;
		firstTodo.setAttribute("checked", true);
		expect((await readColumnContent(copy)).version).not.toBe(before);
	});

	it("treats an empty document as no blocks", async () => {
		expect(await readColumnContent(new Y.Doc())).toMatchObject({ blocks: [] });
		expect(columnBlocksToMarkdown([])).toBe("");
	});
});
