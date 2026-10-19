// Seeded property test: people typing and an agent editing the same column at
// once. Two human documents sync through a server document (the Durable
// Object's), where the agent's edits and undos are applied. Messages are
// delivered late and out of order. Every run must converge, and no character
// a person typed may disappear, or be swapped for a copy, unless that person
// deleted it or an agent deliberately removed the item it was in. Nothing a
// person deleted may come back.
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { columnContentRoot, readColumnBlocks, readColumnContent } from "../src/server/agent-access/column-content";
import { applyAgentEdit, undoAgentChange, type AgentEdit, type ItemStyle, type UndoRecord } from "../src/server/agent-access/column-edits";
import { docFromPlate } from "./helpers/plate-doc";

const RUNS = 10_000;
const STEPS = 30;

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Peer {
	name: string;
	doc: Y.Doc;
}

interface Message {
	from: Peer;
	to: Peer;
	update: Uint8Array;
}

function blocksOf(doc: Y.Doc) {
	const out: Array<{ xml: Y.XmlText; id: string }> = [];
	for (const op of columnContentRoot(doc).toDelta() as Array<{ insert: unknown }>) {
		if (op.insert instanceof Y.XmlText) out.push({ xml: op.insert, id: String(op.insert.getAttribute("id")) });
	}
	return out;
}

function textOf(xml: Y.XmlText): string {
	return (xml.toDelta() as Array<{ insert: unknown }>).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

function fullText(doc: Y.Doc): string {
	return readColumnBlocks(doc).map((block) => block.text).join("\n");
}

/**
 * Per item, the surviving characters a given client typed itself. A copy of
 * someone's text re-typed by another client does not count: their history,
 * and any concurrent deletion they make, attach to their own characters.
 */
function authoredText(doc: Y.Doc, clientID: number): Map<string, string> {
	const byBlock = new Map<string, string>();
	for (const { xml, id } of blocksOf(doc)) {
		let text = "";
		// Yjs internals, read-only: each Item records its author and deletion.
		for (let item = (xml as unknown as { _start: YItem | null })._start; item; item = item.right) {
			if (!item.deleted && item.id.client === clientID && typeof item.content.str === "string") text += item.content.str;
		}
		byBlock.set(id, text);
	}
	return byBlock;
}

interface YItem {
	deleted: boolean;
	id: { client: number };
	content: { str?: string };
	right: YItem | null;
}

const coverage = { undos: 0, undosThatKeptHumanWork: 0, textRewritesDuringConcurrentTyping: 0, staleReadWrites: 0, staleReadWritesRefused: 0, outOfOrderDeliveries: 0 };

function run(seed: number) {
	const random = mulberry32(seed);
	const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
	const initial = Y.encodeStateAsUpdate(
		docFromPlate([
			{ id: "aaaaaaaaaa", type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "one" }] },
			{ id: "bbbbbbbbbb", type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "two" }] },
			{ id: "cccccccccc", type: "p", children: [{ text: "three" }] },
		]),
	);
	const peer = (name: string): Peer => {
		const doc = new Y.Doc();
		Y.applyUpdate(doc, initial);
		return { name, doc };
	};
	const server = peer("server");
	const humans = [peer("A"), peer("B")];
	const queue: Message[] = [];
	// Star topology, as in production: people talk only to the server, which relays.
	// Applying with the sender as origin: the server relays to everyone else,
	// and nobody echoes an update back to where it came from.
	server.doc.on("update", (update: Uint8Array, origin: unknown) => {
		for (const human of humans) if (origin !== human) queue.push({ from: server, to: human, update });
	});
	for (const human of humans) {
		human.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== server) queue.push({ from: human, to: server, update });
		});
	}
	const deliver = (index: number) => {
		if (index > 0) coverage.outOfOrderDeliveries++;
		const [message] = queue.splice(index, 1);
		Y.applyUpdate(message!.to.doc, message!.update, message!.from);
	};

	const alive = new Map<string, { blockId: string; human: Peer }>();
	const deletedByHuman = new Set<string>();
	const tokenBlocks = new Map<string, string>();
	const removedByAgent = new Set<string>();
	const undoable: UndoRecord[] = [];
	const undoDestroyed: string[] = [];
	let tokenCount = 0;
	let agentCount = 0;
	const log: string[] = [];

	// What the agent last read of each item; reads go stale as people type.
	const reads = new Map<string, string>();
	const agentEdit = (edit: AgentEdit) => {
		const before = new Set(blocksOf(server.doc).map((block) => block.id));
		const outcome = applyAgentEdit(server.doc, edit, "agent");
		log.push(`agent ${edit.kind} → ${outcome.ok ? "ok" : outcome.failure.code}`);
		if (!outcome.ok && outcome.failure.code === "item_changed") coverage.staleReadWritesRefused++;
		if (!outcome.ok) return;
		const after = new Set(blocksOf(server.doc).map((block) => block.id));
		// Replace recreates even the items it keeps, so anything typed into the old
		// copies concurrently is deliberately overwritten.
		for (const id of before) if (!after.has(id) || edit.kind === "replace") removedByAgent.add(id);
		undoable.push(outcome.undo);
	};

	for (let step = 0; step < STEPS; step++) {
		const roll = random();
		if (roll < 0.35) {
			// A person types a uniquely recognisable token at either end of an item.
			const human = pick(humans);
			const blocks = blocksOf(human.doc);
			if (blocks.length === 0) continue;
			const block = pick(blocks);
			const token = `‹${human.name}${tokenCount++}›`;
			block.xml.insert(random() < 0.5 ? 0 : textOf(block.xml).length, token);
			alive.set(token, { blockId: block.id, human });
			tokenBlocks.set(token, block.id);
			log.push(`${human.name} types ${token} in ${block.id}`);
		} else if (roll < 0.42) {
			// A person presses Enter: a new item of their own.
			const human = pick(humans);
			const token = `‹${human.name}${tokenCount++}›`;
			const id = `h${human.name}${String(tokenCount).padStart(8, "0")}`;
			const xml = new Y.XmlText();
			xml.setAttribute("id", id);
			xml.setAttribute("type", "p");
			xml.insert(0, token);
			const root = columnContentRoot(human.doc);
			const at = Math.floor(random() * (blocksOf(human.doc).length + 1));
			root.insertEmbed(at, xml);
			alive.set(token, { blockId: id, human });
			tokenBlocks.set(token, id);
			log.push(`${human.name} adds item ${id} with ${token}`);
		} else if (roll < 0.47) {
			// A person deletes one of their own tokens, if they can see it.
			const human = pick(humans);
			const mine = [...alive].filter(([, where]) => where.human === human).map(([token]) => token);
			const token = mine.length ? pick(mine) : null;
			const holder = token && blocksOf(human.doc).find((block) => textOf(block.xml).includes(token));
			if (!token || !holder) continue;
			holder.xml.delete(textOf(holder.xml).indexOf(token), token.length);
			alive.delete(token);
			deletedByHuman.add(token);
			log.push(`${human.name} deletes ${token}`);
		} else if (roll < 0.72) {
			const blocks = blocksOf(server.doc);
			if (random() < 0.3) for (const block of blocks) reads.set(block.id, textOf(block.xml));
			const target = blocks.length ? pick(blocks) : null;
			const choice = random();
			const styles: ItemStyle[] = ["todo", "bullet", "numbered", "paragraph", "heading2"];
			if (choice < 0.3 || !target) {
				agentEdit({ kind: "append", afterId: target && random() < 0.5 ? target.id : null, items: [{ text: `⟪a${agentCount++}⟫`, style: pick(styles) }] });
			} else if (choice < 0.5) {
				const style = target.xml.getAttribute("listStyleType") === "todo";
				agentEdit({ kind: "update", itemId: target.id, changes: style ? { checked: random() < 0.5 } : { style: pick(styles) } });
			} else if (choice < 0.7) {
				// Rewrites an item's text. People may be typing into their own copies of
				// it right now, and the agent may be acting on a read from steps ago.
				if (humans.some((human) => blocksOf(human.doc).some((b) => b.id === target.id && textOf(b.xml) !== textOf(target.xml)))) {
					coverage.textRewritesDuringConcurrentTyping++;
				}
				const read = reads.get(target.id);
				const kind = random();
				if (kind < 0.35) {
					const current = textOf(target.xml);
					agentEdit({ kind: "update", itemId: target.id, changes: { text: `${current} ⟪a${agentCount++}⟫`, expectedText: current } });
				} else if (kind < 0.7 && read !== undefined) {
					coverage.staleReadWrites++;
					agentEdit({ kind: "update", itemId: target.id, changes: { text: `${read} ⟪a${agentCount++}⟫`, expectedText: read } });
				} else {
					const marker = textOf(target.xml).match(/⟪a\d+⟫|one|two|three/)?.[0];
					if (marker) agentEdit({ kind: "update", itemId: target.id, changes: { find: marker, replaceWith: `⟪a${agentCount++}⟫` } });
				}			} else if (choice < 0.85) {
				agentEdit({ kind: "delete", itemIds: [target.id], expectedVersion: readColumnContent(server.doc).version });
			} else if (choice < 0.95 && undoable.length) {
				const record = undoable.splice(Math.floor(random() * undoable.length), 1)[0]!;
				const before = new Map(blocksOf(server.doc).map((block) => [block.id, textOf(block.xml)]));
				const outcome = undoAgentChange(server.doc, record, "agent-undo");
				coverage.undos++;
				if (outcome.kept > 0) coverage.undosThatKeptHumanWork++;
				for (const [id, text] of before) {
					if (blocksOf(server.doc).some((block) => block.id === id)) continue;
					// Undo must never remove an item holding human work the server has seen.
					const seen = [...alive.keys()].filter((token) => text.includes(token));
					if (seen.length) undoDestroyed.push(...seen);
					removedByAgent.add(id);
				}
				log.push(`agent undo ${record.kind} → restored ${outcome.restored}, kept ${outcome.kept}`);
			} else {
				const current = blocksOf(server.doc);
				agentEdit({
					kind: "replace",
					expectedVersion: readColumnContent(server.doc).version,
					items: current.reverse().map((block) => ({ id: block.id, text: textOf(block.xml), style: "paragraph" as const })),
				});
			}
		} else if (queue.length) {
			deliver(Math.floor(random() * queue.length));
		}
	}
	while (queue.length) deliver(Math.floor(random() * queue.length));

	const states = [server, ...humans].map((p) => JSON.stringify(readColumnBlocks(p.doc)));
	const finalText = fullText(server.doc);
	const authored = new Map(humans.map((human) => [human, authoredText(server.doc, human.doc.clientID)]));
	const lost = [...alive]
		.filter(([token, where]) => !deletedByHuman.has(token) && !removedByAgent.has(where.blockId))
		.filter(([token, where]) => !(authored.get(where.human)!.get(where.blockId) ?? "").includes(token))
		.map(([token]) => (finalText.includes(token) ? `${token} (replaced by a copy)` : token));
	const resurrected = [...deletedByHuman]
		.filter((token) => finalText.includes(token))
		.filter((token) => !removedByAgent.has(tokenBlocks.get(token)!))
		.map((token) => `${token} (deleted, then reappeared)`);
	return { converged: new Set(states).size === 1, lost: [...lost, ...resurrected, ...undoDestroyed.map((token) => `${token} (removed by undo)`)], log };
}

describe("people and an agent editing one column at once", () => {
	it(`converge without losing a typed character (${RUNS} seeded runs)`, () => {
		const failures: Array<{ seed: number; converged: boolean; lost: string[]; log: string[] }> = [];
		for (let seed = 1; seed <= RUNS; seed++) {
			const result = run(seed);
			if (!result.converged || result.lost.length) failures.push({ seed, ...result });
		}
		// Report the first failure with its full history, so it can be replayed by seed.
		expect(failures.slice(0, 1)).toEqual([]);
		// The runs must actually reach the hard cases, or passing proves nothing.
		console.log("convergence coverage", coverage);
		expect(coverage.undos).toBeGreaterThan(1000);
		expect(coverage.undosThatKeptHumanWork).toBeGreaterThan(100);
		expect(coverage.textRewritesDuringConcurrentTyping).toBeGreaterThan(100);
		expect(coverage.outOfOrderDeliveries).toBeGreaterThan(10_000);
		expect(coverage.staleReadWritesRefused).toBeGreaterThan(100);
	}, 120_000);
});
