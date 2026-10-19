import type { AgentChangeDiff, AgentDiffItem } from "../../lib/api/agent-contract";
import { currentStyle, type BlockSnapshot, type FieldValues, type UndoRecord } from "./column-edits";

/** Enough entries to read a change at a glance; a rewrite can touch hundreds. */
export const MAX_DIFF_ENTRIES = 50;

type Entry = AgentChangeDiff["entries"][number];

function item(fields: FieldValues): AgentDiffItem {
	const { style, depth, checked } = currentStyle(fields);
	return { text: typeof fields.text === "string" ? fields.text : "", style, checked: style === "todo" && checked, depth };
}

function snapshotFields(saved: BlockSnapshot): FieldValues {
	return { ...saved.attributes, text: saved.runs.map((run) => run.insert).join("") } as FieldValues;
}

function sameItem(left: AgentDiffItem, right: AgentDiffItem): boolean {
	return left.text === right.text && left.style === right.style && left.checked === right.checked && left.depth === right.depth;
}

function capped(entries: Entry[]): AgentChangeDiff {
	return { entries: entries.slice(0, MAX_DIFF_ENTRIES), omitted: Math.max(entries.length - MAX_DIFF_ENTRIES, 0) };
}

/**
 * What a recorded agent change did, as items a person can compare. Built from
 * the change's undo record, so older changes get a diff too. A field edit
 * recorded before `context` existed borrows the item's current fields for
 * whatever the change did not touch.
 */
export function describeAgentChange(record: UndoRecord, current: (id: string) => FieldValues | undefined): AgentChangeDiff {
	try {
		return describe(record, current);
	} catch {
		// A record this code cannot read still lists, with its summary only.
		return capped([]);
	}
}

function describe(record: UndoRecord, current: (id: string) => FieldValues | undefined): AgentChangeDiff {
	switch (record.kind) {
		case "remove-inserted":
			return capped(record.items.map(({ written }) => ({ kind: "added", item: item(written) })));
		case "reinsert":
			return capped(record.items.map(({ snapshot }) => ({ kind: "removed", item: item(snapshotFields(snapshot)) })));
		case "restore-fields": {
			if (Object.keys(record.after).length === 0) return capped([]);
			const context = record.context ?? current(record.id) ?? {};
			return capped([{ kind: "changed", before: item({ ...context, ...record.before }), after: item({ ...context, ...record.after }) }]);
		}
		case "restore-column": {
			const before = new Map<string, AgentDiffItem>();
			const unidentified: AgentDiffItem[] = [];
			for (const saved of record.before) {
				const id = saved.attributes.id;
				if (typeof id === "string" && id) before.set(id, item(snapshotFields(saved)));
				else unidentified.push(item(snapshotFields(saved)));
			}
			const entries: Entry[] = [];
			const kept = new Set<string>();
			for (const written of record.after) {
				const after = item(written);
				const previous = before.get(written.id);
				if (!previous) entries.push({ kind: "added", item: after });
				else {
					kept.add(written.id);
					if (!sameItem(previous, after)) entries.push({ kind: "changed", before: previous, after });
				}
			}
			for (const [id, previous] of before) if (!kept.has(id)) entries.push({ kind: "removed", item: previous });
			for (const previous of unidentified) entries.push({ kind: "removed", item: previous });
			return capped(entries);
		}
		default:
			return capped([]);
	}
}
