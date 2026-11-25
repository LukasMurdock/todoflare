import type { Value } from "@todoflare/board";
import { slateNodesToInsertDelta } from "@slate-yjs/core";
import { z } from "zod";
import { Doc as YDoc, XmlText } from "yjs";
import { columnContentRoot } from "../../src/server/agent-access/column-content";

/** Encodes Plate nodes exactly as the editor's slate-yjs binding does. */
export function docFromPlate(value: Value): YDoc {
	const doc = new YDoc();
	columnContentRoot(doc).applyDelta(slateNodesToInsertDelta(value), { sanitize: false });
	return doc;
}


const inserts = z.array(z.object({ insert: z.unknown() }));
const xmlText = z.instanceof(XmlText);

/** Returns the editor's block elements in their CRDT order. */
export function plateBlocks(doc: YDoc) {
	const delta = inserts.parse(columnContentRoot(doc).toDelta());
	return delta.flatMap(({ insert }) => {
		const parsed = xmlText.safeParse(insert);
		return parsed.success ? [parsed.data] : [];
	});
}
