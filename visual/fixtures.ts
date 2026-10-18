// Deterministic guest content covering every block the board renders.
const text = (value: string) => [{ text: value }];
export const GUEST_COLUMNS = [
	{
		id: "00000000-0000-4000-8000-00000000000a",
		value: [
			{ type: "h1", children: text("Groceries") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: text("Milk") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: false, children: text("Bread") },
			{ type: "p", listStyleType: "todo", indent: 2, checked: false, children: text("Sourdough") },
			{ type: "h2", children: text("Notes") },
			{ type: "p", listStyleType: "disc", indent: 1, children: text("Bullet item") },
			{ type: "p", listStyleType: "decimal", indent: 1, children: text("First numbered") },
			{ type: "p", listStyleType: "decimal", indent: 1, listStart: 2, children: text("Second numbered") },
			{ type: "h3", children: text("Links") },
			{ type: "p", children: text("See example.com/docs for details") },
		],
	},
	{ id: "00000000-0000-4000-8000-00000000000b", collapsed: true, value: [{ type: "p", children: text("Hidden") }] },
	{ id: "00000000-0000-4000-8000-00000000000c", value: [{ type: "p", children: text("") }] },
];
