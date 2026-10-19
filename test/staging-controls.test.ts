import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import staging from "../src/staging";
import production from "../src/index";
import { checkRateLimit, ipRateLimitKey } from "../src/lib/rate-limit";
import { resetStagingData } from "../src/staging-reset";
import { agentStore } from "../src/server/agent-access/store";
import { oauthClients } from "../src/server/oauth/authorization-server";

function request(path: string, token?: string, body: unknown = {}) {
	return new Request(`https://staging.todo.tamesystems.org/api/admin/staging/${path}`, {
		method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
	});
}

describe("staging recovery controls", () => {
	it("does not expose staging controls from the production entry point", async () => {
		for (const path of ["lose-account", "reset-rate-limits", "reset-data"]) {
			const response = await production.fetch(request(path, "secret"), env, createExecutionContext());
			expect(response.status).toBe(404);
		}
	});
	it("requires the staging environment and admin secret", async () => {
		const ctx = createExecutionContext();
		expect((await staging.fetch(request("scheduled", "secret"), { ...env, BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(404);
		expect((await staging.fetch(request("scheduled"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(401);
		expect((await staging.fetch(request("scheduled", "wrong"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(401);
		expect((await staging.fetch(request("reset-rate-limits"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(401);
		expect((await staging.fetch(request("reset-rate-limits", "secret"), { ...env, BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(404);
		await waitOnExecutionContext(ctx);
	});
	it("will not simulate account loss without a freeze and marked synthetic case", async () => {
		const bindings = { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" };
		const body = { accountId: "1234567890123456", key: "accounts/1234567890123456/copy.json" };
		expect((await staging.fetch(request("lose-account", "secret", body), bindings, createExecutionContext())).status).toBe(409);
		expect((await staging.fetch(request("lose-account", "secret", body), { ...bindings, READ_ONLY_MODE: "true" }, createExecutionContext())).status).toBe(403);
	});
	it("freezes credential enrollment, deletion and recovery-code rotation", async () => {
		for (const path of ["sign-in/anonymous", "passkey/verify-registration", "passkey/delete-passkey", "recovery-code/generate", "recovery-code/recover"]) {
			const response = await production.fetch(new Request(`http://localhost:5173/api/auth/${path}`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
			}), { ...env, READ_ONLY_MODE: "true" }, createExecutionContext());
			expect(response.status).toBe(503);
		}
		const options = await production.fetch(new Request("http://localhost:5173/api/auth/passkey/generate-register-options"), { ...env, READ_ONLY_MODE: "true" }, createExecutionContext());
		expect(options.status).toBe(503);
	});
	it("requires admin authentication for manual backup execution", async () => {
		for (const [path, method] of [["run", "POST"], ["objects", "GET"], ["download", "GET"]]) {
			const response = await production.fetch(new Request(`http://localhost:5173/api/admin/backups/${path}`, { method }), { ...env, BACKUP_ADMIN_TOKEN: "secret" }, createExecutionContext());
			expect(response.status).toBe(401);
		}
	});
	it("resets only the caller's IP rate-limit windows", async () => {
		const bindings = { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" };
		const createAccount = { limit: 5, windowSeconds: 3600 };
		const exhaust = async (key: string) => {
			for (let i = 0; i < createAccount.limit; i++) await checkRateLimit(env.RATE_LIMIT_COORDINATOR, key, createAccount);
			return (await checkRateLimit(env.RATE_LIMIT_COORDINATOR, key, createAccount)).allowed;
		};
		const callerKey = ipRateLimitKey("create-account", "203.0.113.9");
		const otherKey = ipRateLimitKey("create-account", "198.51.100.4");
		expect(await exhaust(callerKey)).toBe(false);
		expect(await exhaust(otherKey)).toBe(false);

		const reset = new Request("https://staging.todo.tamesystems.org/api/admin/staging/reset-rate-limits", {
			method: "POST", headers: { Authorization: "Bearer secret", "CF-Connecting-IP": "203.0.113.9" },
		});
		expect((await staging.fetch(reset, bindings, createExecutionContext())).status).toBe(200);
		expect((await checkRateLimit(env.RATE_LIMIT_COORDINATOR, callerKey, createAccount)).allowed).toBe(true);
		expect((await checkRateLimit(env.RATE_LIMIT_COORDINATOR, otherKey, createAccount)).allowed).toBe(false);
	});
	it("runs the real frozen scheduled handler without changing backup state", async () => {
		await env.BACKUPS.put("backup-state.json", JSON.stringify({ sentinel: "preserve" }));
		const response = await staging.fetch(request("scheduled", "secret"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret", READ_ONLY_MODE: "true" }, createExecutionContext());
		expect(await response.json()).toEqual({ success: true, frozen: true });
		expect(await (await env.BACKUPS.get("backup-state.json"))!.json()).toEqual({ sentinel: "preserve" });
	});

	it("refuses to reset data while frozen", async () => {
		const bindings = { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret", READ_ONLY_MODE: "true" };
		expect((await staging.fetch(request("reset-data", "secret"), bindings, createExecutionContext())).status).toBe(409);
	});
	it("resets agent connections, tokens, grants and OAuth clients with the accounts", async () => {
		const store = agentStore(env.AUTH_DB);
		const created = await store.create({ userId: "1234567890123456", name: "agent", expiresInDays: 1, now: Date.now() });
		if (!created.ok) throw new Error("setup");
		await store.setGrant({ userId: "1234567890123456", connectionId: created.value.agent.id, columnId: crypto.randomUUID(), level: "read", expiresAt: null, now: Date.now() });
		await oauthClients(env.AUTH_DB, () => Promise.reject(new Error("no fetch"))).register({ redirect_uris: ["https://app.example/cb"] }, Date.now());
		for (let done = false; !done; ) done = (await resetStagingData(env, 50)).done;
		for (const table of ["agent_connection", "agent_token", "agent_grant", "oauth_client", "oauth_code"]) {
			const row = await env.AUTH_DB.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).first<{ count: number }>();
			expect([table, row?.count]).toEqual([table, 0]);
		}
		expect(await store.resolveToken(created.value.token, Date.now())).toBeNull();
	});
	it("resets every account, column, record, backup and credential, in bounded batches", async () => {
		const accounts: string[] = [];
		const columns: string[] = [];
		for (let i = 0; i < 3; i++) {
			const created = await production.fetch(new Request("http://localhost/api/account", {
				method: "POST", headers: { "X-Forwarded-For": `10.20.${i}.1` },
			}), env, createExecutionContext());
			const accountId = ((await created.json()) as { account: { id: string } }).account.id.replace(/\D/g, "");
			accounts.push(accountId);
			const column = await production.fetch(new Request("http://localhost/api/column", {
				method: "POST", headers: { "X-Todoflare-Test-Account": accountId, "Content-Type": "application/json" }, body: "{}",
			}), env, createExecutionContext());
			columns.push(((await column.json()) as { column: { id: string } }).column.id);
		}
		await env.BACKUPS.put("columns/example/1.json", "{}");
		await env.AUTH_DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0, 0)').bind("u1", "n", "u1@example.com").run();

		const rounds: boolean[] = [];
		for (let round = 0; round < 20; round++) {
			const { done } = await resetStagingData(env, 2);
			rounds.push(done);
			if (done) break;
		}

		expect(rounds.at(-1)).toBe(true);
		expect(rounds.length).toBeGreaterThan(1);
		expect((await env.ACCOUNTS.list()).keys).toEqual([]);
		expect((await env.BACKUPS.list()).objects).toEqual([]);
		expect((await env.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n).toBe(0);
		for (const columnId of columns) {
			const meta = await env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId)).fetch(new Request("http://do/meta"));
			expect(meta.status).toBe(404);
		}
	});
});
