import { slateNodesToInsertDelta } from "@slate-yjs/core";
import * as Y from "yjs";
import { columnContentRoot } from "../../src/server/agent-access/column-content";

/** Encodes Plate nodes exactly as the editor's slate-yjs binding does. */
export function docFromPlate(value: Array<Record<string, unknown>>): Y.Doc {
	const doc = new Y.Doc();
	columnContentRoot(doc).applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
	return doc;
}
