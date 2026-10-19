import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Bindings } from "../src/index";
import {
	AGENT_CONNECTIONS_PER_ACCOUNT,
	type AgentConnection,
	createAgentResponseSchema,
	listAgentsResponseSchema,
	agentResponseSchema,
} from "../src/lib/api/agent-contract";
import { ACCOUNT_COMMANDS } from "../src/lib/api/account-commands";
import { API_ROUTES, routePath } from "../src/lib/api/routes";
import { agentStore, agentTokenHash } from "../src/server/agent-access/store";
import { createAccount, createColumn, headers } from "./helpers/metadata-fixtures";

const BASE = "http://example.com";

async function call(accountId: string | null, route: { method: string; path: string }, body?: unknown, extra: Record<string, string> = {}) {
	return SELF.fetch(`${BASE}${route.path}`, {
		method: route.method,
		headers: { ...(accountId ? headers(accountId) : { "Content-Type": "application/json" }), ...extra },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function createAgent(accountId: string, name = "Claude Code") {
	const response = await call(accountId, API_ROUTES.createAgent, { name });
	expect(response.status).toBe(201);
	return createAgentResponseSchema.parse(await response.json());
}

function commandRoute(name: "column.share" | "column.delete", columnId: string) {
	const { method, path } = ACCOUNT_COMMANDS[name];
	return { method, path: routePath(path, { id: columnId }) };
}

function grantRoute(method: "PUT" | "DELETE", agentId: string, columnId: string) {
	return { method, path: routePath(API_ROUTES.setAgentGrant.path, { agentId, id: columnId }) };
}

async function setGrant(accountId: string, agentId: string, columnId: string, body: unknown = { level: "read" }) {
	return call(accountId, grantRoute("PUT", agentId, columnId), body);
}

async function listAgents(accountId: string): Promise<AgentConnection[]> {
	const response = await call(accountId, API_ROUTES.listAgents);
	expect(response.status).toBe(200);
	return listAgentsResponseSchema.parse(await response.json()).agents;
}

async function fetchWithEnv(request: Request, overrides: Partial<Bindings>) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...overrides } as Bindings, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("agent management routes", () => {
	it("returns a token exactly once and stores only its hash", async () => {
		const owner = await createAccount();
		const { agent, token } = await createAgent(owner.id);
		expect(token).toMatch(/^tfa_[A-Za-z0-9_-]{43}$/);
		expect(agent.grants).toEqual([]);

		const listed = await call(owner.id, API_ROUTES.listAgents);
		expect(await listed.text()).not.toContain(token);
		expect(listed.headers.get("Cache-Control")).toBe("private, no-store");

		const stored = await env.AUTH_DB.prepare('SELECT "tokenHash" FROM "agent_token" WHERE "connectionId" = ?')
			.bind(agent.id)
			.all<{ tokenHash: string }>();
		expect(stored.results).toEqual([{ tokenHash: await agentTokenHash(token) }]);
		expect(await agentStore(env.AUTH_DB).resolveToken(token, Date.now())).toMatchObject({ id: agent.id });
	});

	it("grants columns the account owns or that are shared with it, and nothing else", async () => {
		const me = await createAccount();
		const friend = await createAccount();
		const stranger = await createAccount();
		const mine = await createColumn(me.id);
		const sharedWithMe = await createColumn(friend.id);
		const notMine = await createColumn(stranger.id);
		const share = await call(friend.id, commandRoute("column.share", sharedWithMe), { targetAccountId: me.id });
		expect(share.ok).toBe(true);
		const { agent } = await createAgent(me.id);

		expect((await setGrant(me.id, agent.id, mine, { level: "edit" })).status).toBe(200);
		expect((await setGrant(me.id, agent.id, sharedWithMe, { level: "append" })).status).toBe(200);
		expect((await setGrant(me.id, agent.id, notMine)).status).toBe(404);
		expect((await setGrant(me.id, agent.id, crypto.randomUUID())).status).toBe(404);

		const [listed] = await listAgents(me.id);
		expect(listed.grants.map(({ columnId, level }) => ({ columnId, level })).sort((a, b) => a.columnId.localeCompare(b.columnId))).toEqual(
			[
				{ columnId: mine, level: "edit" },
				{ columnId: sharedWithMe, level: "append" },
			].sort((a, b) => a.columnId.localeCompare(b.columnId)),
		);
	});

	it("updates a grant's level in place", async () => {
		const me = await createAccount();
		const column = await createColumn(me.id);
		const { agent } = await createAgent(me.id);
		await setGrant(me.id, agent.id, column, { level: "edit" });
		const response = await setGrant(me.id, agent.id, column, { level: "read" });
		expect(agentResponseSchema.parse(await response.json()).agent.grants).toMatchObject([{ columnId: column, level: "read" }]);
	});

	it("refuses grants on trashed columns", async () => {
		const me = await createAccount();
		const column = await createColumn(me.id);
		const { agent } = await createAgent(me.id);
		const trashed = await call(me.id, commandRoute("column.delete", column));
		expect(trashed.ok).toBe(true);
		expect((await setGrant(me.id, agent.id, column)).status).toBe(404);
	});

	it("refuses grant expiries in the past", async () => {
		const me = await createAccount();
		const column = await createColumn(me.id);
		const { agent } = await createAgent(me.id);
		expect((await setGrant(me.id, agent.id, column, { level: "read", expiresAt: Date.now() - 1 })).status).toBe(400);
	});

	it("hides one account's agents from every other account", async () => {
		const me = await createAccount();
		const other = await createAccount();
		const column = await createColumn(other.id);
		const { agent } = await createAgent(me.id);

		expect(await listAgents(other.id)).toEqual([]);
		expect((await setGrant(other.id, agent.id, column)).status).toBe(404);
		expect((await call(other.id, grantRoute("DELETE", agent.id, column))).status).toBe(404);
		expect((await call(other.id, { method: "DELETE", path: routePath(API_ROUTES.revokeAgent.path, { agentId: agent.id }) })).status).toBe(404);
		expect(await listAgents(me.id)).toHaveLength(1);
	});

	it("revokes tokens and grants together", async () => {
		const me = await createAccount();
		const column = await createColumn(me.id);
		const { agent, token } = await createAgent(me.id);
		await setGrant(me.id, agent.id, column, { level: "edit" });

		const revoke = await call(me.id, { method: "DELETE", path: routePath(API_ROUTES.revokeAgent.path, { agentId: agent.id }) });
		expect(revoke.status).toBe(200);
		expect(await agentStore(env.AUTH_DB).resolveToken(token, Date.now())).toBeNull();
		expect(await agentStore(env.AUTH_DB).grants(agent.id)).toEqual([]);
		expect(await listAgents(me.id)).toEqual([]);
		// A revoked connection cannot be granted to again.
		expect((await setGrant(me.id, agent.id, column)).status).toBe(404);
	});

	it("removes a single grant", async () => {
		const me = await createAccount();
		const kept = await createColumn(me.id);
		const removed = await createColumn(me.id);
		const { agent } = await createAgent(me.id);
		await setGrant(me.id, agent.id, kept);
		await setGrant(me.id, agent.id, removed);
		const response = await call(me.id, grantRoute("DELETE", agent.id, removed));
		expect(agentResponseSchema.parse(await response.json()).agent.grants.map((grant) => grant.columnId)).toEqual([kept]);
	});

	it("caps live connections per account", async () => {
		const me = await createAccount();
		for (let index = 0; index < AGENT_CONNECTIONS_PER_ACCOUNT; index++) await createAgent(me.id, `agent ${index}`);
		expect((await call(me.id, API_ROUTES.createAgent, { name: "one too many" })).status).toBe(409);
	});

	it("never accepts an agent token as a management credential", async () => {
		const me = await createAccount();
		const { token } = await createAgent(me.id);
		const response = await call(null, API_ROUTES.listAgents, undefined, {
			Authorization: `Bearer ${token}`,
			"X-Test-Disable-Auth-Bypass": "1",
		});
		expect(response.status).toBe(401);
	});

	it("validates names and identifiers", async () => {
		const me = await createAccount();
		expect((await call(me.id, API_ROUTES.createAgent, { name: "  " })).status).toBe(400);
		expect((await call(me.id, API_ROUTES.createAgent, { name: "x", extra: true })).status).toBe(400);
		expect((await call(me.id, { method: "DELETE", path: "/api/agents/not-an-agent" })).status).toBe(400);
	});

	it("stops new access but still allows revocation in read-only mode", async () => {
		const me = await createAccount();
		const column = await createColumn(me.id);
		const { agent } = await createAgent(me.id);
		await setGrant(me.id, agent.id, column);
		const request = (method: string, path: string, body?: unknown) =>
			new Request(`${BASE}${path}`, { method, headers: headers(me.id), body: body === undefined ? undefined : JSON.stringify(body) });
		const readOnly = { READ_ONLY_MODE: "true" };

		expect((await fetchWithEnv(request("POST", API_ROUTES.createAgent.path, { name: "x" }), readOnly)).status).toBe(503);
		expect((await fetchWithEnv(request("PUT", grantRoute("PUT", agent.id, column).path, { level: "edit" }), readOnly)).status).toBe(503);
		expect((await fetchWithEnv(request("DELETE", grantRoute("DELETE", agent.id, column).path), readOnly)).status).toBe(200);
		expect((await fetchWithEnv(request("DELETE", routePath(API_ROUTES.revokeAgent.path, { agentId: agent.id })), readOnly)).status).toBe(200);
	});

	it("serves nothing while the feature is disabled", async () => {
		const me = await createAccount();
		const response = await fetchWithEnv(new Request(`${BASE}${API_ROUTES.listAgents.path}`, { headers: headers(me.id) }), {
			AGENT_ACCESS_ENABLED: "false",
		});
		expect(response.status).toBe(404);
	});
});
