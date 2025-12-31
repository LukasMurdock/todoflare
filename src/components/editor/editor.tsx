import { Editor, EditorContainer } from "@/components/ui/editor";
import { MarkdownPlugin, remarkMention, remarkMdx } from "@platejs/markdown";

import { Plate, usePlateEditor } from "platejs/react";
import { KEYS, type Value } from "platejs";
import { BlockquoteElement } from "@/components/ui/blockquote-node";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { H1Element, H2Element, H3Element } from "@/components/ui/heading-node";
import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { ToolbarButton } from "@/components/ui/toolbar";
import {
	BlockquotePlugin,
	BoldPlugin,
	H1Plugin,
	H2Plugin,
	H3Plugin,
	ItalicPlugin,
	UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { BlockList } from "../ui/block-list";

const initialValue: Value = [
	{
		type: "p",
		children: [
			{ text: "Hello! Try out the " },
			{ text: "bold", bold: true },
			{ text: ", " },
			{ text: "italic", italic: true },
			{ text: ", and " },
			{ text: "underline", underline: true },
			{ text: " formatting." },
		],
	},
];

export default function App() {
	const editor = usePlateEditor({
		plugins: [
			BoldPlugin,
			ItalicPlugin,
			UnderlinePlugin,
			H1Plugin.withComponent(H1Element),
			H2Plugin.withComponent(H2Element),
			H3Plugin.withComponent(H3Element),
			BlockquotePlugin.withComponent(BlockquoteElement),
			MarkdownPlugin.configure({
				options: {
					// Add remark plugins for syntax extensions (GFM, Math, MDX)
					remarkPlugins: [remarkMdx, remarkMention],
					// Define custom rules if needed
					rules: {
						// date: { /* ... rule implementation ... */ },
					},
				},
			}),
			ListPlugin.configure({
				inject: {
					targetPlugins: [
						...KEYS.heading,
						KEYS.p,
						KEYS.blockquote,
						KEYS.codeBlock,
						KEYS.toggle,
						KEYS.img,
					],
				},
				render: {
					belowNodes: BlockList,
				},
			}),
		],
		value: () => {
			const savedValue = localStorage.getItem("installation-react-demo");
			return savedValue ? JSON.parse(savedValue) : initialValue;
		},
	});

	return (
		<Plate editor={editor}>
			<FixedToolbar className="flex justify-start gap-1 rounded-t-lg">
				{/* Element Toolbar Buttons */}
				<ToolbarButton onClick={() => editor.tf.h1.toggle()}>
					H1
				</ToolbarButton>
				<ToolbarButton onClick={() => editor.tf.h2.toggle()}>
					H2
				</ToolbarButton>
				<ToolbarButton onClick={() => editor.tf.h3.toggle()}>
					H3
				</ToolbarButton>
				<ToolbarButton onClick={() => editor.tf.blockquote.toggle()}>
					Quote
				</ToolbarButton>
				{/* Mark Toolbar Buttons */}
				<MarkToolbarButton nodeType="bold" tooltip="Bold (⌘+B)">
					B
				</MarkToolbarButton>
				<MarkToolbarButton nodeType="italic" tooltip="Italic (⌘+I)">
					I
				</MarkToolbarButton>
				<MarkToolbarButton
					nodeType="underline"
					tooltip="Underline (⌘+U)"
				>
					U
				</MarkToolbarButton>
			</FixedToolbar>
			<EditorContainer>
				<Editor placeholder="Type your amazing content here..." />
			</EditorContainer>
		</Plate>
	);
}
