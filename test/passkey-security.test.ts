import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { softwareAuthenticator, type SoftwareAuthenticator } from "./helpers/software-authenticator";
import { displayAccountId } from "../src/lib/account";
import { passkeyUser } from "../src/lib/passkey-identity";

const ORIGIN = "http://localhost:5173";

/** A browser's cookie jar for one origin: later Set-Cookie values replace earlier ones. */
class Browser {
	private cookies = new Map<string, string>();

	async fetch(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Origin", ORIGIN);
		if (init.body) headers.set("Content-Type", "application/json");
		if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
		const response = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(";");
			const index = pair.indexOf("=");
			const [name, value] = [pair.slice(0, index), pair.slice(index + 1)];
			if (value && !/Max-Age=0/i.test(cookie)) this.cookies.set(name, value);
			else this.cookies.delete(name);
		}
		return response;
	}

	async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
		const response = await this.fetch(path, init);
		return { status: response.status, body: await response.json() as T };
	}

	async accountId(): Promise<string | null> {
		return (await this.json<{ accountId: string | null }>("/api/auth-status")).body.accountId;
	}

	async signInAnonymously(): Promise<string> {
		const { body } = await this.json<{ user: { id: string } }>("/api/auth/sign-in/anonymous", { method: "POST" });
		return body.user.id;
	}

	async register(authenticator: SoftwareAuthenticator, verified = true) {
		const options = await this.json<{ challenge: string; error?: string }>("/api/auth/passkey/generate-register-options?name=Laptop");
		if (options.status !== 200) return options;
		const response = await authenticator.register(options.body, verified);
		return this.json<{ error?: string }>("/api/auth/passkey/verify-registration", {
			method: "POST",
			body: JSON.stringify({ name: "Laptop", response }),
		});
	}

	async authenticate(authenticator: SoftwareAuthenticator, verified = true) {
		const options = await this.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
		const response = await authenticator.authenticate(options.body, verified);
		return this.json<{ error?: string }>("/api/auth/passkey/verify-authentication", {
			method: "POST",
			body: JSON.stringify({ response }),
		});
	}
}

async function enrolledAccount() {
	const browser = new Browser();
	const accountId = await browser.signInAnonymously();
	const authenticator = await softwareAuthenticator(ORIGIN, "localhost");
	expect((await browser.register(authenticator)).status).toBe(200);
	return { browser, accountId, authenticator };
}

async function ageSessions(accountId: string, minutes = 10) {
	await env.AUTH_DB.prepare('UPDATE "session" SET "createdAt" = ? WHERE "userId" = ?')
		.bind(Date.now() - minutes * 60 * 1000, accountId)
		.run();
}

async function passkeyCount(accountId: string): Promise<number> {
	const row = await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM "passkey" WHERE "userId" = ?')
		.bind(accountId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

describe("passkey security policy", () => {
	beforeAll(async () => {
		await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
	});

	it("refuses a registration that the authenticator did not user-verify", async () => {
		const browser = new Browser();
		const accountId = await browser.signInAnonymously();
		const authenticator = await softwareAuthenticator(ORIGIN, "localhost");

		const unverified = await browser.register(authenticator, false);
		expect(unverified).toMatchObject({ status: 400, body: { error: "user_verification_required" } });
		expect(await passkeyCount(accountId)).toBe(0);

		expect((await browser.register(authenticator, true)).status).toBe(200);
		expect(await passkeyCount(accountId)).toBe(1);
	});

	it("names every passkey after its account, not the passkey's label", async () => {
		const browser = new Browser();
		const accountId = await browser.signInAnonymously();
		const options = await browser.json<{ user: unknown }>("/api/auth/passkey/generate-register-options?name=Laptop");
		expect(options.body.user).toEqual(passkeyUser(accountId));
		expect(passkeyUser(accountId)).toMatchObject({ name: displayAccountId(accountId) });
		// The same handle for every passkey of the account, so one signal reaches all of them.
		expect((await browser.register(await softwareAuthenticator(ORIGIN, "localhost"))).status).toBe(200);
		await ageSessions(accountId, 0);
		const second = await browser.json<{ user: { id: string } }>("/api/auth/passkey/generate-register-options?name=Phone");
		expect(second.body.user.id).toBe(passkeyUser(accountId).id);
	});

	it("requires and enforces user verification at sign-in", async () => {
		const { accountId, authenticator } = await enrolledAccount();
		const browser = new Browser();

		const options = await browser.json<{ userVerification?: string }>("/api/auth/passkey/generate-authenticate-options");
		expect(options.body.userVerification).toBe("required");

		const unverified = await browser.authenticate(authenticator, false);
		expect(unverified).toMatchObject({ status: 400, body: { error: "user_verification_required" } });
		expect(await browser.accountId()).toBeNull();

		expect((await browser.authenticate(authenticator, true)).status).toBe(200);
		expect(await browser.accountId()).toBe(accountId);
	});

	it("needs a recent sign-in to add another passkey, and accepts one after confirming", async () => {
		const { browser, accountId, authenticator } = await enrolledAccount();
		await ageSessions(accountId);

		const stale = await browser.register(await softwareAuthenticator(ORIGIN, "localhost"));
		expect(stale).toMatchObject({ status: 401, body: { error: "recent_authentication_required" } });
		expect(await passkeyCount(accountId)).toBe(1);

		expect((await browser.authenticate(authenticator)).status).toBe(200);
		expect((await browser.register(await softwareAuthenticator(ORIGIN, "localhost"))).status).toBe(200);
		expect(await passkeyCount(accountId)).toBe(2);
	});

	it("lets an account with no credentials enroll its first passkey on any session", async () => {
		const browser = new Browser();
		const accountId = await browser.signInAnonymously();
		// Older than Better Auth's default 24-hour freshness: a sign-up resumed later.
		await ageSessions(accountId, 2 * 24 * 60);
		expect((await browser.register(await softwareAuthenticator(ORIGIN, "localhost"))).status).toBe(200);
	});

	it("needs a recent sign-in to create or rotate the recovery code", async () => {
		const { browser, accountId } = await enrolledAccount();
		await ageSessions(accountId);
		const stale = await browser.json<{ error?: string }>("/api/auth/recovery-code/generate", { method: "POST" });
		expect(stale).toMatchObject({ status: 401, body: { error: "recent_authentication_required" } });
		const row = await env.AUTH_DB.prepare('SELECT "recoveryCodeHash" FROM "user" WHERE "id" = ?')
			.bind(accountId)
			.first<{ recoveryCodeHash: string | null }>();
		expect(row?.recoveryCodeHash).toBeNull();

		await ageSessions(accountId, 0);
		const fresh = await browser.json<{ recoveryCode?: string }>("/api/auth/recovery-code/generate", { method: "POST" });
		expect(fresh.status).toBe(200);
		expect(fresh.body.recoveryCode).toEqual(expect.any(String));
	});

	it("refuses a credential change addressed to a different account than the session's", async () => {
		const { browser, accountId } = await enrolledAccount();
		const other = "1111111111111111";
		for (const path of ["/api/auth/recovery-code/generate", "/api/auth/revoke-other-sessions", "/api/auth/passkey/verify-registration"]) {
			const refused = await browser.json<{ error?: string }>(path, {
				method: "POST",
				headers: { "X-Todoflare-Expected-Account": other },
				body: "{}",
			});
			expect(refused).toMatchObject({ status: 401, body: { error: "account_mismatch" } });
		}
		const listed = await browser.json<{ error?: string }>("/api/auth/passkey/list-user-passkeys", {
			headers: { "X-Todoflare-Expected-Account": other },
		});
		expect(listed).toMatchObject({ status: 401, body: { error: "account_mismatch" } });
		const accepted = await browser.json("/api/auth/recovery-code/generate", {
			method: "POST",
			headers: { "X-Todoflare-Expected-Account": accountId },
		});
		expect(accepted.status).toBe(200);
		expect(await browser.accountId()).toBe(accountId);
	});

	it("ends every other session when an account is recovered", async () => {
		const { browser: original, accountId, authenticator } = await enrolledAccount();
		const other = new Browser();
		expect((await other.authenticate(authenticator)).status).toBe(200);
		const { body } = await original.json<{ recoveryCode: string }>("/api/auth/recovery-code/generate", { method: "POST" });

		const recovering = new Browser();
		const recovered = await recovering.json<{ accountId?: string }>("/api/auth/recovery-code/recover", {
			method: "POST",
			body: JSON.stringify({ accountId, recoveryCode: body.recoveryCode }),
		});
		expect(recovered.status).toBe(200);

		expect(await recovering.accountId()).toBe(accountId);
		expect(await original.accountId()).toBeNull();
		expect(await other.accountId()).toBeNull();
	});
});
