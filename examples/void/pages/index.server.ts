import { defineHandler } from "void";

// Board content as a host would load it from its own storage.
export const loader = defineHandler((c) =>
	c.json({
		columns: [
			{
				id: "00000000-0000-4000-8000-0000000000a1",
				content: [
					{ type: "h1", children: [{ text: "Team board" }] },
					{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "Rendered on the server" }] },
					{ type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "Editable after hydration" }] },
				],
			},
		],
	}),
);

export const prerender = false;
