import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { softwareAuthenticator, type SoftwareAuthenticator } from "./software-authenticator";

/**
 * A browser with real passkey sessions for Worker tests: a cookie jar on the
 * one origin where Better Auth's WebAuthn checks pass (RP ID "localhost").
 * Use it, not the X-Todoflare-Test-Account fixture, wherever session age or
 * passkey ceremonies matter.
 */
export const ORIGIN = "http://localhost:5173";

/** A browser's cookie jar for one origin: later Set-Cookie values replace earlier ones. */
export class Browser {
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

/** An account with one user-verified passkey, signed in just now. */
export async function enrolledAccount() {
	const browser = new Browser();
	const accountId = await browser.signInAnonymously();
	const authenticator = await softwareAuthenticator(ORIGIN, "localhost");
	expect((await browser.register(authenticator)).status).toBe(200);
	return { browser, accountId, authenticator };
}

/** Makes the account's sessions `minutes` old (0: created now). */
export async function ageSessions(accountId: string, minutes = 10) {
	await env.AUTH_DB.prepare('UPDATE "session" SET "createdAt" = ? WHERE "userId" = ?')
		.bind(Date.now() - minutes * 60 * 1000, accountId)
		.run();
}
