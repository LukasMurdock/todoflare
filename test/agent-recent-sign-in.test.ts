// Agent connections and grants outlive the session that makes them, so making
// or widening one needs a recent sign-in (decision 0017). These use real
// passkey sessions: the test fixture account has no session age to check.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES, routePath } from "../src/lib/api/routes";
import { ageSessions, enrolledAccount, ORIGIN } from "./helpers/passkey-browser";
import { createColumn } from "./helpers/metadata-fixtures";
import { authorizeParams, pkce, register } from "./helpers/oauth-fixtures";

async function signedInAccount() {
	const account = await enrolledAccount();
	expect((await account.browser.fetch(API_ROUTES.createAccount.path, { method: "POST" })).ok).toBe(true);
	return account;
}

const refused = { status: 401, body: { code: "recent_authentication_required" } };

describe("agent credentials need a recent sign-in", () => {
	beforeAll(async () => {
		await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
	});

	it("to connect an agent", async () => {
		const { browser, accountId, authenticator } = await signedInAccount();
		await ageSessions(accountId);
		const create = () => browser.json(API_ROUTES.createAgent.path, { method: "POST", body: JSON.stringify({ name: "Claude Code" }) });
		expect(await create()).toMatchObject(refused);

		expect((await browser.authenticate(authenticator)).status).toBe(200);
		expect((await create()).status).toBe(201);
	});

	it("to widen an agent's access, but not to narrow it", async () => {
		const { browser, accountId } = await signedInAccount();
		const columnId = await createColumn(accountId);
		const created = await browser.json<{ agent: { id: string } }>(API_ROUTES.createAgent.path, { method: "POST", body: JSON.stringify({ name: "Claude Code" }) });
		const grant = routePath(API_ROUTES.setAgentGrant.path, { agentId: created.body.agent.id, id: columnId });
		expect((await browser.fetch(grant, { method: "PUT", body: JSON.stringify({ level: "read" }) })).status).toBe(200);

		await ageSessions(accountId);
		expect(await browser.json(grant, { method: "PUT", body: JSON.stringify({ level: "edit" }) })).toMatchObject(refused);
		expect((await browser.fetch(grant, { method: "DELETE" })).status).toBe(200);
		const revoke = routePath(API_ROUTES.revokeAgent.path, { agentId: created.body.agent.id });
		expect((await browser.fetch(revoke, { method: "DELETE" })).status).toBe(200);
	});

	it("to approve an OAuth client, but not to decline one", async () => {
		const { browser, accountId, authenticator } = await signedInAccount();
		const { body: client } = await register();
		const { challenge } = await pkce();
		const params = authorizeParams(String(client.client_id), challenge, { resource: `${ORIGIN}/api/mcp` });
		const decide = (decision: Record<string, unknown>) =>
			browser.json<{ redirectTo?: string }>(API_ROUTES.decideAuthorization.path, { method: "POST", body: JSON.stringify({ params, ...decision }) });
		const approve = { decision: "approve", name: "Claude Code", expiresInDays: 30, grants: [] };

		await ageSessions(accountId);
		expect(await decide(approve)).toMatchObject(refused);
		const declined = await decide({ decision: "deny" });
		expect(declined.status).toBe(200);
		expect(new URL(declined.body.redirectTo!).searchParams.get("error")).toBe("access_denied");

		expect((await browser.authenticate(authenticator)).status).toBe(200);
		const approved = await decide(approve);
		expect(approved.status).toBe(200);
		expect(new URL(approved.body.redirectTo!).searchParams.get("code")).toEqual(expect.any(String));
	});
});
