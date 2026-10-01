import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import staging from "../src/staging";
import production from "../src/index";

function request(path: string, token?: string, body: unknown = {}) {
	return new Request(`https://staging.todo.tamesystems.org/api/admin/staging/${path}`, {
		method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
	});
}

describe("staging recovery controls", () => {
	it("does not expose staging controls from the production entry point", async () => {
		const response = await production.fetch(request("lose-account", "secret"), env, createExecutionContext());
		expect(response.status).toBe(404);
	});
	it("requires the staging environment and admin secret", async () => {
		const ctx = createExecutionContext();
		expect((await staging.fetch(request("scheduled", "secret"), { ...env, BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(404);
		expect((await staging.fetch(request("scheduled"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(401);
		expect((await staging.fetch(request("scheduled", "wrong"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret" }, ctx)).status).toBe(401);
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
	it("runs the real frozen scheduled handler without changing backup state", async () => {
		await env.BACKUPS.put("backup-state.json", JSON.stringify({ sentinel: "preserve" }));
		const response = await staging.fetch(request("scheduled", "secret"), { ...env, ENVIRONMENT: "staging", BACKUP_ADMIN_TOKEN: "secret", READ_ONLY_MODE: "true" }, createExecutionContext());
		expect(await response.json()).toEqual({ success: true, frozen: true });
		expect(await (await env.BACKUPS.get("backup-state.json"))!.json()).toEqual({ sentinel: "preserve" });
	});
});
