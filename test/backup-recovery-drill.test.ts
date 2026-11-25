import { applyD1Migrations, env, reset } from "cloudflare:test";
import { yTextToSlateElement } from "@slate-yjs/core";
import { assert, beforeAll, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { z } from "zod";
import { getAccountResponseSchema } from "../src/lib/api/account-contract";
import { API_ROUTES } from "../src/lib/api/routes";
import { normalizeAccountId } from "../src/lib/account";
import { columnContentRoot } from "../src/server/agent-access/column-content";
import type { AccountExportPayload } from "../src/types/account";
import { callTool, createAgent, fetchWithEnv, seedColumn, setGrant } from "./helpers/agent-fixtures";
import { createColumn } from "./helpers/metadata-fixtures";
import { Browser, enrolledAccount, ORIGIN } from "./helpers/passkey-browser";

const adminToken = "isolated-recovery-drill";
async function backupRequest(path: string, body: { accountId: string; key?: string }) {
	return fetchWithEnv(new Request(`${ORIGIN}/api/admin/backups/${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify(body),
	}), { BACKUP_ADMIN_TOKEN: adminToken, READ_ONLY_MODE: "true" });
}

async function archiveSyntheticBoard() {
	const { browser, accountId, authenticator } = await enrolledAccount();
	expect((await browser.fetch(API_ROUTES.createAccount.path, { method: "POST" })).ok).toBe(true);
	const second = await createColumn(accountId, "00000000-0000-4000-8000-000000000002");
	const first = await createColumn(accountId, "00000000-0000-4000-8000-000000000001");
	const contents = new Map([
		[first, [{ type: "h1", id: "heading", children: [{ text: "Recovery plan" }] }]],
		[second, [{ type: "p", id: "task", listStyleType: "todo", checked: true, indent: 1, children: [{ text: "Check the spare key" }] }]],
	]);
	await Promise.all(Array.from(contents, ([id, nodes]) => seedColumn(id, nodes)));
	const original = await browser.json<AccountExportPayload>(API_ROUTES.exportAccount.path);
	expect(original.status).toBe(200);
	expect(original.body.account.columnOrder).toEqual([second, first]);
	const { agent, token } = await createAgent(accountId);
	expect((await setGrant(accountId, agent.id, first)).ok).toBe(true);
	const beforeLoss = await callTool(token, "read_column", { columnId: first });
	expect(beforeLoss.body?.result?.structuredContent).toMatchObject({ markdown: expect.stringContaining("Recovery plan") });
	const snapshot = await backupRequest("account", { accountId });
	expect(snapshot.status).toBe(200);
	const { key } = z.object({ key: z.string() }).parse(await snapshot.json());
	const inventory = await env.BACKUPS.list();
	expect(inventory.truncated).toBe(false);
	const archive = await Promise.all(inventory.objects.map(async ({ key: objectKey }) => {
		const stored = await env.BACKUPS.get(objectKey);
		assert(stored);
		return [objectKey, await stored.arrayBuffer()] as const;
	}));
	return { archive, key, accountId, browser, authenticator, token, first, second, contents };
}

let source: Awaited<ReturnType<typeof archiveSyntheticBoard>>;
beforeAll(async () => {
	source = await archiveSyntheticBoard();
});

it("restores a board into empty bindings using only the archived R2 objects and its surviving passkey", async () => {
	const { archive, key, accountId, browser, authenticator, token, first, second, contents } = source;
	await reset();
	await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
	expect((await env.BACKUPS.list()).objects).toHaveLength(0);
	expect((await env.ACCOUNTS.list()).keys).toHaveLength(0);
	expect(await env.AUTH_DB.prepare("SELECT id FROM user").first()).toBeNull();
	await Promise.all(archive.map(([name, bytes]) => env.BACKUPS.put(name, bytes)));

	const restored = await backupRequest("account/restore", { accountId, key });
	expect(restored.status).toBe(200);
	expect(await restored.json()).toMatchObject({ success: true, restoredColumns: expect.arrayContaining([first, second]) });
	expect((await browser.fetch(API_ROUTES.exportAccount.path)).status).toBe(401);
	expect(await env.AUTH_DB.prepare("SELECT id FROM session").first()).toBeNull();
	expect(await env.AUTH_DB.prepare("SELECT columnId FROM agent_grant").first()).toBeNull();
	expect((await callTool(token, "read_column", { columnId: first })).status).toBe(401);

	const fresh = new Browser();
	expect((await fresh.authenticate(authenticator)).status).toBe(200);
	expect(await fresh.accountId()).toBe(accountId);
	const hydration = await fresh.fetch(API_ROUTES.getAccount.path);
	expect(hydration.status).toBe(200);
	const hydrated = getAccountResponseSchema.parse(await hydration.json());
	expect(hydrated.account.columnOrder).toEqual([second, first]);
	const agents = await fresh.fetch(API_ROUTES.listAgents.path);
	expect(agents.status).toBe(200);
	expect(await agents.json()).toMatchObject({ agents: [] });
	const board = await fresh.json<AccountExportPayload>(API_ROUTES.exportAccount.path);
	expect(board.status).toBe(200);
	expect(board.body.account.columnOrder).toEqual([second, first]);
	expect(board.body.ownedColumns.map(column => column.meta.id).toSorted((left, right) => left.localeCompare(right))).toEqual([first, second]);
	for (const column of board.body.ownedColumns) {
		expect(normalizeAccountId(column.meta.ownerId)).toBe(accountId);
		assert(column.yjs);
		const doc = new Doc();
		applyUpdate(doc, Uint8Array.from(column.yjs));
		expect(yTextToSlateElement(columnContentRoot(doc)).children).toEqual(contents.get(column.meta.id));
		doc.destroy();
	}
});
