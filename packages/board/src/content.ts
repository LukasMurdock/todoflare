import type { Value } from "platejs";

/** True for no blocks or a single empty paragraph: what a new column holds. */
export function isEmptyContent(value: Value): boolean {
	if (value.length === 0) return true;
	if (value.length !== 1) return false;
	const [block] = value;
	if (block.type !== "p" || !Array.isArray(block.children) || block.children.length !== 1) return false;
	const [child] = block.children;
	return typeof child === "object" && "text" in child && child.text === "";
}
