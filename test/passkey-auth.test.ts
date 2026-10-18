import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

describe("passkey authentication boundary", () => {
	beforeAll(async () => {
		await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
	});
	it("creates only a provisional identity and never exposes its synthetic email", async () => {
		const response = await SELF.fetch("http://localhost:5173/api/auth/sign-in/anonymous", {
			method: "POST",
			headers: { Origin: "http://localhost:5173" },
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("accounts.invalid");
		expect(text).not.toContain('"email"');
		const body = JSON.parse(text) as { user: { id: string } };
		expect(body.user.id).toMatch(/^\d{16}$/);

		const cookie = response.headers.get("Set-Cookie");
		expect(cookie).toContain("better-auth.session_token");
		const status = await SELF.fetch("http://localhost:5173/api/auth-status", {
			headers: { Cookie: cookie ?? "" },
		});
		expect(await status.json()).toEqual({
			accountId: body.user.id,
			state: "provisional",
		});

		const options = await SELF.fetch(
			"http://localhost:5173/api/auth/passkey/generate-register-options?name=Primary",
			{ headers: { Cookie: cookie ?? "" } },
		);
		expect(options.status).toBe(200);
		const registration = (await options.json()) as {
			rp?: { id?: string };
			user?: { id?: string; name?: string };
		};
		expect(registration.rp?.id).toBe("localhost");
		expect(registration.user?.name).not.toContain("accounts.invalid");
	});

	it("does not accept an Account ID as a bearer credential", async () => {
		const response = await SELF.fetch("http://localhost:5173/api/account", {
			headers: {
				Authorization: "Bearer 1111111111111111",
				"X-Test-Disable-Auth-Bypass": "1",
			},
		});
		expect(response.status).toBe(401);
	});
	it("preserves an existing cookie session while rejecting every retired ID transport", async () => {
		const login = await SELF.fetch("http://localhost:5173/api/auth/sign-in/anonymous", { method: "POST", headers: { Origin: "http://localhost:5173" } });
		const { user } = await login.json() as { user: { id: string } };
		const cookie = login.headers.get("Set-Cookie")!;
		await env.AUTH_DB.prepare('INSERT INTO passkey (id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES (?, \'fixture\', ?, ?, 0, \'singleDevice\', 0)').bind(crypto.randomUUID(), user.id, crypto.randomUUID()).run();
		await env.AUTH_DB.prepare('UPDATE "user" SET authState = \'passkey\' WHERE id = ?').bind(user.id).run();
		await env.ACCOUNTS.put(`account:${user.id}`, JSON.stringify({ schemaVersion: 1, id: user.id, columnOrder: [], hiddenSharedColumns: [], createdAt: 1 }));
		for (const [name, value] of [["Authorization", `Bearer ${user.id}`], ["X-Account-ID", user.id]]) {
			const response = await SELF.fetch("http://localhost:5173/api/account", { headers: { [name]: value, "X-Test-Disable-Auth-Bypass": "1" } });
			expect(response.status).toBe(401);
		}
		const retiredLogin = await SELF.fetch("http://localhost:5173/api/auth/legacy/sign-in", { method: "POST", headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ accountId: user.id }) });
		expect(retiredLogin.status).toBe(404);
		expect((await SELF.fetch(`http://localhost:5173/api/account/${user.id}`, { headers: { Cookie: cookie } })).status).toBe(404);
		const account = await SELF.fetch("http://localhost:5173/api/account", { headers: { Cookie: cookie, "X-Test-Disable-Auth-Bypass": "1" } });
		expect(account.status).toBe(200);
		expect((await account.json() as { account: { id: string } }).account.id.replace(/\D/g, "")).toBe(user.id);
		const mismatch = await SELF.fetch("http://localhost:5173/api/column", {
			method: "POST", headers: { Cookie: cookie, "X-Test-Disable-Auth-Bypass": "1", "X-Todoflare-Expected-Account": "1111111111111111" },
		});
		expect(mismatch.status).toBe(401);

	});

	it.each([
		["/api/auth-status", "GET", 200],
		["/api/account", "GET", 200],
		["/api/column/00000000-0000-4000-8000-000000000001/ws-ticket", "POST", 404],
	] as const)("refreshes the browser cookie through %s", async (path, method, statusCode) => {
		const login = await SELF.fetch("http://localhost:5173/api/auth/sign-in/anonymous", {
			method: "POST", headers: { Origin: "http://localhost:5173" },
		});
		const { user } = await login.json() as { user: { id: string } };
		const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
		await env.AUTH_DB.prepare("INSERT INTO passkey (id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES (?, 'fixture', ?, ?, 0, 'singleDevice', 0)").bind(crypto.randomUUID(), user.id, crypto.randomUUID()).run();
		await env.ACCOUNTS.put(`account:${user.id}`, JSON.stringify({ schemaVersion: 1, id: user.id, columnOrder: [], hiddenSharedColumns: [], createdAt: 1 }));
		// Put the session inside Better Auth's rolling refresh window without
		// changing its token/signature. Ordinary app traffic must renew both sides.
		await env.AUTH_DB.prepare('UPDATE session SET "expiresAt" = ? WHERE "userId" = ?').bind(Date.now() + 60 * 60 * 1000, user.id).run();
		const response = await SELF.fetch(`http://localhost:5173${path}`, {
			method, headers: { Cookie: cookie, "X-Test-Disable-Auth-Bypass": "1" },
		});
		expect(response.status).toBe(statusCode);
		const renewed = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="));
		expect(renewed).toContain("Max-Age=604800");
		const row = await env.AUTH_DB.prepare('SELECT "expiresAt" FROM session WHERE "userId" = ?').bind(user.id).first<{ expiresAt: string | number }>();
		expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
	});

	it("clears an expired session cookie and refuses account access", async () => {
		const login = await SELF.fetch("http://localhost:5173/api/auth/sign-in/anonymous", { method: "POST", headers: { Origin: "http://localhost:5173" } });
		const { user } = await login.json() as { user: { id: string } };
		await env.AUTH_DB.prepare('UPDATE session SET "expiresAt" = ? WHERE "userId" = ?').bind(Date.now() - 1000, user.id).run();
		const response = await SELF.fetch("http://localhost:5173/api/account", { headers: { Cookie: login.headers.get("Set-Cookie")!, "X-Test-Disable-Auth-Bypass": "1" } });
		expect(response.status).toBe(401);
		expect(response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))).toContain("Max-Age=0");
	});

});
