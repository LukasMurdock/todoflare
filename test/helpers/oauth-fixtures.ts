import { SELF } from "cloudflare:test";
import { API_ROUTES } from "../../src/lib/api/routes";
import { BASE } from "./agent-fixtures";

/** OAuth client registration and authorization requests for Worker tests. */

export const ORIGIN = BASE;
export const REDIRECT = "http://127.0.0.1:33418/callback";

export function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce() {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

let ipCounter = 0;
/** Registration and token requests are rate limited per IP; each test client gets its own. */
export function clientIp(): string {
	ipCounter++;
	return `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

export async function register(
	body: Record<string, unknown> = { client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
	ip = clientIp(),
) {
	const response = await SELF.fetch(`${BASE}${API_ROUTES.oauthRegister.path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "https://other.example", "CF-Connecting-IP": ip },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
	return {
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "xyz-state",
		resource: `${ORIGIN}/api/mcp`,
		...extra,
	};
}
