// Agent writes end to end: MCP tool → Worker decision → the column's Durable
// Object → persisted, logged, and broadcast to people connected to the column.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { listAgentChangesResponseSchema, undoAgentChangeResponseSchema } from "../src/lib/api/agent-contract";
import { API_ROUTES, routePath } from "../src/lib/api/routes";
import { decodeWsMessage, encodeDurableSyncSubmission, WS_PROTOCOL_V1 } from "../src/lib/collaboration/websocket-protocol";
import { columnBlocksToMarkdown, columnContentRoot, readColumnContent } from "../src/server/agent-access/column-content";
import { call, callTool, commandRoute, createAgent, MCP_ERAS, routeForRevoke, seedColumn, setGrant } from "./helpers/agent-fixtures";
import { createAccount, createColumn } from "./helpers/metadata-fixtures";

const SEED = [
	{ id: "titleaaaaa", type: "h2", children: [{ text: "Errands" }] },
	{ id: "milkaaaaaa", type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "Milk" }] },
];

async function setup(level: "read" | "append" | "edit" = "edit") {
	const owner = await createAccount();
	const columnId = await createColumn(owner.id);
	await seedColumn(columnId, SEED);
	const { agent, token } = await createAgent(owner.id, "Claude");
	expect((await setGrant(owner.id, agent.id, columnId, { level })).status).toBe(200);
	return { owner, columnId, agent, token };
}

function result(response: Awaited<ReturnType<typeof callTool>>) {
	expect(response.status).toBe(200);
	return response.body!.result!;
}

async function markdownOf(columnId: string): Promise<string> {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(await (await stub.fetch("http://do/yjs-state")).arrayBuffer()));
	return columnBlocksToMarkdown(readColumnContent(doc).blocks);
}

async function versionOf(token: string, columnId: string): Promise<string> {
	return String(result(await callTool(token, "read_column", { columnId })).structuredContent!.version);
}

/** A person's editor, connected to the column like the app's. */
async function connectPerson(columnId: string, accountId: string) {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const ticket = await stub.fetch("http://do/ws-ticket", { method: "POST", headers: { "X-Authenticated-Account-ID": accountId.replace(/\s/g, "") } });
	const { ticket: value } = (await ticket.json()) as { ticket: string };
	const response = await stub.fetch(new Request(`http://do/?ticket=${encodeURIComponent(value)}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": WS_PROTOCOL_V1 } }));
	const ws = (response as unknown as { webSocket: WebSocket }).webSocket;
	(ws as unknown as { accept(): void }).accept();
	const doc = new Y.Doc();
	const synced: Array<() => void> = [];
	ws.addEventListener("message", (event) => {
		const message = decodeWsMessage(event.data as ArrayBuffer);
		if (message?.type === "sync") {
			Y.applyUpdate(doc, message.data, "server");
			synced.splice(0).forEach((resolve) => resolve());
		}
	});
	let outbox = 0;
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "server") ws.send(encodeDurableSyncSubmission(`person-${++outbox}`, update));
	});
	const nextSync = () => new Promise<void>((resolve) => synced.push(resolve));
	await nextSync(); // Initial state.
	return { doc, ws, nextSync, markdown: () => columnBlocksToMarkdown(readColumnContent(doc).blocks) };
}

/**
 * Waits until the server and the person both hold `text`. Polls instead of
 * sleeping, so the test neither races delivery nor waits longer than needed.
 */
async function settled(columnId: string, person: { markdown(): string }, text: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if ((await markdownOf(columnId)).includes(text) && person.markdown().includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Never settled on ${JSON.stringify(text)}: server ${JSON.stringify(await markdownOf(columnId))}, person ${JSON.stringify(person.markdown())}`);
}

function blockXml(doc: Y.Doc, id: string): Y.XmlText {
	for (const op of columnContentRoot(doc).toDelta() as Array<{ insert: unknown }>) {
		if (op.insert instanceof Y.XmlText && op.insert.getAttribute("id") === id) return op.insert;
	}
	throw new Error(`no block ${id}`);
}

async function listChanges(accountId: string, columnId: string) {
	const response = await call(accountId, { method: "GET", path: routePath(API_ROUTES.listAgentChanges.path, { id: columnId }) });
	expect(response.status).toBe(200);
	return listAgentChangesResponseSchema.parse(await response.json()).changes;
}

async function personUndo(accountId: string, columnId: string, changeId: string) {
	return call(accountId, { method: "POST", path: routePath(API_ROUTES.undoAgentChange.path, { id: columnId, changeId }) });
}

describe.each(MCP_ERAS)("agent writes (%s protocol)", (era) => {
	const opts = { era };

	it("adds items that a connected person sees at once", async () => {
		const { owner, columnId, token } = await setup("append");
		const person = await connectPerson(columnId, owner.id);
		const arrived = person.nextSync();
		const added = result(await callTool(token, "append_items", { columnId, items: [{ text: "Bread" }, { text: "Call mum", style: "bullet" }] }, opts));
		expect(added.isError).toBeUndefined();
		expect(added.structuredContent).toMatchObject({ summary: "Added 2 items", itemIds: [expect.any(String), expect.any(String)] });
		await arrived;
		expect(person.markdown()).toMatch(/^## Errands \^titleaaaaa\n- \[ \] Milk \^milkaaaaaa\n- \[ \] Bread \^\S+\n- Call mum \^\S+$/);
		person.ws.close();
	});

	it("persists agent edits across a Durable Object restart", async () => {
		const { columnId, token } = await setup();
		result(await callTool(token, "set_checked", { columnId, itemId: "milkaaaaaa", checked: true }, opts));
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		await runInDurableObject(stub, (instance) => {
			// Reload from storage exactly as a fresh activation would.
			const room = instance as unknown as { doc: Y.Doc; loadStateFromSql(): void };
			room.doc = new Y.Doc();
			room.loadStateFromSql();
		});
		expect(await markdownOf(columnId)).toContain("- [x] Milk ^milkaaaaaa");
	});

	it("merges with a person typing in the same item", async () => {
		const { owner, columnId, token } = await setup();
		const person = await connectPerson(columnId, owner.id);
		// The person types before the agent's edit reaches them, and vice versa.
		blockXml(person.doc, "milkaaaaaa").insert(4, " (oat)");
		result(await callTool(token, "update_item", { columnId, itemId: "milkaaaaaa", find: "Milk", replaceWith: "Whole Milk" }, opts));
		await settled(columnId, person, "Whole Milk (oat)");
		expect(await markdownOf(columnId)).toContain("- [ ] Whole Milk (oat) ^milkaaaaaa");
		expect(person.markdown()).toContain("- [ ] Whole Milk (oat) ^milkaaaaaa");
		person.ws.close();
	});

	it("never overwrites a person's edit with a whole-text write from a stale read", async () => {
		const { owner, columnId, token } = await setup();
		const person = await connectPerson(columnId, owner.id);
		blockXml(person.doc, "milkaaaaaa").insert(4, " (oat)");
		await settled(columnId, person, "Milk (oat)");
		const refused = result(await callTool(token, "update_item", { columnId, itemId: "milkaaaaaa", text: "Whole Milk", expectedText: "Milk" }, opts));
		expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('"Milk (oat)"') }] });
		expect(await markdownOf(columnId)).toContain("- [ ] Milk (oat) ^milkaaaaaa");
		person.ws.close();
	});

	it("refuses destructive edits made against a stale read", async () => {
		const { owner, columnId, token } = await setup();
		const version = await versionOf(token, columnId);
		const person = await connectPerson(columnId, owner.id);
		blockXml(person.doc, "milkaaaaaa").insert(0, "Buy ");
		await settled(columnId, person, "Buy Milk");
		const stale = result(await callTool(token, "delete_items", { columnId, itemIds: ["milkaaaaaa"], expectedVersion: version }, opts));
		expect(stale).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("changed since it was read") }] });
		const fresh = await versionOf(token, columnId);
		expect(result(await callTool(token, "delete_items", { columnId, itemIds: ["milkaaaaaa"], expectedVersion: fresh }, opts)).isError).toBeUndefined();
		expect(await markdownOf(columnId)).toBe("## Errands ^titleaaaaa");
		person.ws.close();
	});

	it("logs every change for the column's members, and lets them undo it", async () => {
		const { owner, columnId, token, agent } = await setup();
		const added = result(await callTool(token, "append_items", { columnId, items: [{ text: "Bread" }] }, opts));
		result(await callTool(token, "set_checked", { columnId, itemId: "milkaaaaaa", checked: true }, opts));
		const changes = await listChanges(owner.id, columnId);
		expect(changes.map((change) => [change.summary, change.agentName, change.agentId, change.tool])).toEqual([
			['Checked "Milk"', "Claude", agent.id, "set_checked"],
			['Added "Bread"', "Claude", agent.id, "append_items"],
		]);

		const undone = await personUndo(owner.id, columnId, String(added.structuredContent!.changeId));
		expect(undoAgentChangeResponseSchema.parse(await undone.json())).toMatchObject({ restored: 1, kept: 0 });
		expect(await markdownOf(columnId)).toBe("## Errands ^titleaaaaa\n- [x] Milk ^milkaaaaaa");
		expect((await personUndo(owner.id, columnId, String(added.structuredContent!.changeId))).status).toBe(409);
		const [, logged] = await listChanges(owner.id, columnId);
		expect(logged).toMatchObject({ undoneBy: owner.id.replace(/\s/g, ""), undoResult: { restored: 1, kept: 0 } });
	});

	it("does not log a no-op", async () => {
		const { owner, columnId, token } = await setup();
		const response = result(await callTool(token, "set_checked", { columnId, itemId: "milkaaaaaa", checked: false }, opts));
		expect(response.structuredContent).toMatchObject({ changeId: null });
		expect(await listChanges(owner.id, columnId)).toEqual([]);
	});

	it("lets an agent undo its own changes only", async () => {
		const { owner, columnId, token } = await setup();
		const other = await createAgent(owner.id, "Other agent");
		await setGrant(owner.id, other.agent.id, columnId, { level: "edit" });
		const mine = result(await callTool(token, "append_items", { columnId, items: [{ text: "Mine" }] }, opts));
		const changeId = String(mine.structuredContent!.changeId);

		const foreign = result(await callTool(other.token, "undo_change", { columnId, changeId }, opts));
		expect(foreign).toMatchObject({ isError: true, content: [{ text: "No change with that ID from this agent in this column." }] });
		const own = result(await callTool(token, "undo_change", { columnId, changeId }, opts));
		expect(own.structuredContent).toMatchObject({ restored: 1, kept: 0 });
		expect((await listChanges(owner.id, columnId))[0]).toMatchObject({ undoneBy: expect.stringMatching(/^agent:agt_/) });
	});

	it("needs the change's own level to undo it", async () => {
		const { owner, columnId, token, agent } = await setup("edit");
		const checked = result(await callTool(token, "set_checked", { columnId, itemId: "milkaaaaaa", checked: true }, opts));
		await setGrant(owner.id, agent.id, columnId, { level: "append" });
		const refused = result(await callTool(token, "undo_change", { columnId, changeId: String(checked.structuredContent!.changeId) }, opts));
		expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("does not allow") }] });
	});

	it("rewrites a column, keeping identities, and undoes the rewrite", async () => {
		const { owner, columnId, token } = await setup();
		const version = await versionOf(token, columnId);
		const replaced = result(
			await callTool(token, "replace_column", {
				columnId,
				expectedVersion: version,
				items: [{ id: "milkaaaaaa", text: "Milk", style: "todo" }, { id: "titleaaaaa", text: "Errands", style: "heading2" }],
			}, opts),
		);
		expect(await markdownOf(columnId)).toBe("- [ ] Milk ^milkaaaaaa\n## Errands ^titleaaaaa");
		await personUndo(owner.id, columnId, String(replaced.structuredContent!.changeId));
		expect(await markdownOf(columnId)).toBe("## Errands ^titleaaaaa\n- [ ] Milk ^milkaaaaaa");
	});

	it.each([
		["multi-line text", "append_items", { items: [{ text: "a\nb" }] }],
		["checked on a bullet", "append_items", { items: [{ text: "a", style: "bullet", checked: true }] }],
		["an empty update", "update_item", { itemId: "milkaaaaaa" }],
		["an unknown item", "set_checked", { itemId: "nopenopeno", checked: true }],
		["too many items", "append_items", { items: Array.from({ length: 101 }, () => ({ text: "x" })) }],
	])("explains %s as a tool error", async (_name, tool, args) => {
		const { columnId, token } = await setup();
		const before = await markdownOf(columnId);
		const response = result(await callTool(token, tool, { columnId, ...args }, opts));
		expect(response.isError).toBe(true);
		expect(await markdownOf(columnId)).toBe(before);
	});

	it("stops writing the moment access ends", async () => {
		const { owner, columnId, token, agent } = await setup();
		result(await callTool(token, "append_items", { columnId, items: [{ text: "before" }] }, opts));
		expect((await call(owner.id, routeForRevoke(agent.id))).status).toBe(200);
		expect((await callTool(token, "append_items", { columnId, items: [{ text: "after" }] }, opts)).status).toBe(401);
		expect(await markdownOf(columnId)).not.toContain("after");
	});
});

describe("agent changes and column lifecycle", () => {
	it("hides a column's agent changes from non-members", async () => {
		const { columnId, token } = await setup();
		result(await callTool(token, "append_items", { columnId, items: [{ text: "x" }] }));
		const stranger = await createAccount();
		const response = await call(stranger.id, { method: "GET", path: routePath(API_ROUTES.listAgentChanges.path, { id: columnId }) });
		expect(response.status).toBe(404);
		const changes = await listChanges((await createAccount()).id, columnId).catch(() => null);
		expect(changes).toBeNull();
	});

	it("lets a collaborator see and undo agent changes on a shared column", async () => {
		const { owner, columnId, token } = await setup();
		const friend = await createAccount();
		expect((await call(owner.id, commandRoute("column.share", columnId), { targetAccountId: friend.id })).ok).toBe(true);
		const added = result(await callTool(token, "append_items", { columnId, items: [{ text: "x" }] }));
		expect(await listChanges(friend.id, columnId)).toHaveLength(1);
		expect((await personUndo(friend.id, columnId, String(added.structuredContent!.changeId))).status).toBe(200);
	});

	it("keeps the change log to 30 days and 1000 entries", async () => {
		const { owner, columnId, token } = await setup();
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		type Sql = { ctx: { storage: { sql: SqlStorage } } };
		const count = () =>
			runInDurableObject(stub, (instance) => (instance as unknown as Sql).ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_changes").one().n);
		const seed = (rows: Array<{ id: string; createdAt: number }>) =>
			runInDurableObject(stub, (instance) => {
				for (const row of rows)
					(instance as unknown as Sql).ctx.storage.sql.exec(
						`INSERT INTO agent_changes (id, connection_id, account_id, agent_name, tool, required_level, summary, item_ids, undo, created_at)
						 VALUES (?, ?, ?, 'Seed', 'append_items', 'append', 'seeded', '[]', '{}', ?)`,
						row.id, `agt_${"seed".padEnd(22, "x")}`, owner.id.replace(/\s/g, ""), row.createdAt,
					);
			});
		// Seeded rows use well-formed IDs, since listing validates them.
		const changeId = (name: string) => `chg_${name.padEnd(22, "x")}`;
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		await seed([
			{ id: changeId("expired"), createdAt: now - 31 * day },
			...Array.from({ length: 1000 }, (_, index) => ({ id: changeId(`seed_${index}_`), createdAt: now - 2 * day + index })),
		]);

		// Recording a change prunes in the same transaction.
		const added = result(await callTool(token, "append_items", { columnId, items: [{ text: "Bread" }] }));
		expect(await count()).toBe(1000);
		const newest = await listChanges(owner.id, columnId);
		expect(newest[0]!.id).toBe(added.structuredContent!.changeId);
		const ids = await runInDurableObject(stub, (instance) =>
			(instance as unknown as Sql).ctx.storage.sql.exec<{ id: string }>("SELECT id FROM agent_changes").toArray().map((row) => row.id),
		);
		expect(ids).not.toContain(changeId("expired"));
		expect(ids).not.toContain(changeId("seed_0_"));
		expect(ids).toContain(changeId("seed_1_"));

		// Compaction prunes expired entries even when no agent writes again, and
		// below the row cap, so only the age rule can remove this one.
		await runInDurableObject(stub, (instance) => (instance as unknown as Sql).ctx.storage.sql.exec("DELETE FROM agent_changes WHERE id LIKE 'chg_seed_1%'"));
		const belowCap = await count();
		expect(belowCap).toBeLessThan(1000);
		await seed([{ id: changeId("expired_again"), createdAt: now - 31 * day }]);
		await runInDurableObject(stub, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
		expect(await count()).toBe(belowCap);
	});

	it("forgets recorded changes when an import replaces the content", async () => {
		const { owner, columnId, token } = await setup();
		result(await callTool(token, "append_items", { columnId, items: [{ text: "x" }] }));
		await seedColumn(columnId, SEED);
		expect(await listChanges(owner.id, columnId)).toEqual([]);
	});

	it("refuses agent writes to a trashed column, even if the Worker is bypassed", async () => {
		const { owner, columnId, agent } = await setup();
		expect((await call(owner.id, commandRoute("column.delete", columnId))).ok).toBe(true);
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const response = await stub.fetch("http://do/agent-edit", {
			method: "POST",
			body: JSON.stringify({ accountId: owner.id, connectionId: agent.id, agentName: "x", tool: "append_items", requiredLevel: "append", edit: { kind: "append", afterId: null, items: [{ text: "x", style: "todo" }] } }),
		});
		expect(response.status).toBe(404);
	});

	it("refuses agent writes for an account that is not a member, even if the Worker is bypassed", async () => {
		const { columnId, agent } = await setup();
		const stranger = await createAccount();
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const response = await stub.fetch("http://do/agent-edit", {
			method: "POST",
			body: JSON.stringify({ accountId: stranger.id, connectionId: agent.id, agentName: "x", tool: "append_items", requiredLevel: "append", edit: { kind: "append", afterId: null, items: [{ text: "x", style: "todo" }] } }),
		});
		expect(response.status).toBe(404);
	});
});
