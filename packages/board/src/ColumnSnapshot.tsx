import * as React from "react";
import type { Value } from "platejs";
import { createSlateEditor } from "platejs";
import { EditorStatic } from "./ui/editor-static";
import { editorVariants } from "./ui/editor";
import { isEmptyContent } from "./content";
import { columnSnapshotPlugins } from "./column-editor-plugins";

/** Slate's inline placeholder style, copied so the static placeholder lands on the same pixels. */
const SLATE_PLACEHOLDER_STYLE: React.CSSProperties = {
	position: "absolute",
	top: 0,
	pointerEvents: "none",
	width: "100%",
	maxWidth: "100%",
	display: "block",
	opacity: 0.333,
	userSelect: "none",
	textDecoration: "none",
};

/**
 * A column's content rendered without an editor: shown until the column's
 * document opens, and the only rendering on a server. Matches the live editor's
 * markup so the swap is invisible.
 */
export function ColumnSnapshot({ value, placeholder }: { value: Value; placeholder?: string }) {
	const editor = React.useMemo(
		() => createSlateEditor({ plugins: columnSnapshotPlugins, value }),
		[value],
	);

	if (placeholder && isEmptyContent(value)) {
		// An empty paragraph with Slate's placeholder, as the live editor renders it.
		return (
			// The live editor's classes carry its placeholder positioning rules.
			<div className={editorVariants({ variant: "column" })}>
				<div className="slate-p" style={{ position: "relative" }}>
					<span>
						<span>
							<span>{"\uFEFF"}</span>
							<span data-slate-placeholder="true" style={SLATE_PLACEHOLDER_STYLE}>
								{placeholder}
							</span>
						</span>
					</span>
				</div>
			</div>
		);
	}

	return <EditorStatic editor={editor} variant="column" />;
}
