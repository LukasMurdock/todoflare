// OAuth 2.1 for MCP clients, end to end: discovery, registration, consent,
// code exchange with PKCE, refresh rotation, and every refusal the
// MCP 2026-07-28 authorization specification requires.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../src/lib/api/routes";
import { agentStore } from "../src/server/agent-access/store";
import { isAllowedRedirectUri, oauthClients, redirectUriMatches, validateAuthorizationRequest, type MetadataFetcher } from "../src/server/oauth/authorization-server";
import { BASE, callTool, listAgents, MCP_ERAS, withConnectionsAtGrantLimit } from "./helpers/agent-fixtures";
import { createAccount, createColumn, headers } from "./helpers/metadata-fixtures";
import { authorizeParams, base64Url, clientIp, ORIGIN, pkce, REDIRECT, register } from "./helpers/oauth-fixtures";

async function decide(accountId: string | null, body: Record<string, unknown>) {
	const response = await SELF.fetch(`${BASE}${API_ROUTES.decideAuthorization.path}`, {
		method: "POST",
		headers: accountId ? headers(accountId) : { "Content-Type": "application/json", "X-Test-Disable-Auth-Bypass": "1" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as { redirectTo?: string; display?: string } };
}

async function token(form: Record<string, string>) {
	const response = await SELF.fetch(`${BASE}${API_ROUTES.oauthToken.path}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://other.example", "CF-Connecting-IP": clientIp() },
		body: new URLSearchParams(form).toString(),
	});
	return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, string | number> };
}

/** Registers a client, has a person approve one column at `level`, and returns the code. */
async function approved(level: "read" | "append" | "edit" = "append") {
	const person = await createAccount();
	const columnId = await createColumn(person.id);
	const { body: client } = await register();
	const { verifier, challenge } = await pkce();
	const params = authorizeParams(String(client.client_id), challenge);
	const decision = await decide(person.id, { decision: "approve", params, name: "Claude Code", expiresInDays: 30, grants: [{ columnId, level }] });
	expect(decision.status).toBe(200);
	const redirect = new URL(decision.body.redirectTo!);
	return { person, columnId, clientId: String(client.client_id), verifier, redirect, code: redirect.searchParams.get("code")! };
}

async function exchange(flow: Awaited<ReturnType<typeof approved>>, overrides: Record<string, string> = {}) {
	return token({
		grant_type: "authorization_code",
		code: flow.code,
		client_id: flow.clientId,
		redirect_uri: REDIRECT,
		code_verifier: flow.verifier,
		resource: `${ORIGIN}/api/mcp`,
		...overrides,
	});
}

describe("OAuth discovery", () => {
	it("starts from the 401 the MCP endpoint returns", async () => {
		const response = await SELF.fetch(`${BASE}${API_ROUTES.mcp.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(response.status).toBe(401);
		const challenge = response.headers.get("WWW-Authenticate")!;
		const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
		expect(metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);

		const resource = (await (await SELF.fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
		expect(resource).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
		const root = (await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource`)).json()) as { resource: string };
		expect(root.resource).toBe(`${ORIGIN}/api/mcp`);

		const issuer = resource.authorization_servers[0]!;
		const metadata = (await (await SELF.fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
		expect(metadata).toMatchObject({
			issuer,
			authorization_endpoint: `${ORIGIN}/oauth/authorize`,
			token_endpoint: `${ORIGIN}/api/oauth/token`,
			registration_endpoint: `${ORIGIN}/api/oauth/register`,
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			client_id_metadata_document_supported: true,
			authorization_response_iss_parameter_supported: true,
		});
	});

	it("marks a rejected token as invalid_token", async () => {
		const response = await SELF.fetch(`${BASE}${API_ROUTES.mcp.path}`, { method: "POST", headers: { Authorization: `Bearer tfa_${"A".repeat(43)}` }, body: "{}" });
		expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
	});

	it("serves browser-based clients on other origins", async () => {
		const preflight = await SELF.fetch(`${BASE}${API_ROUTES.oauthToken.path}`, { method: "OPTIONS", headers: { Origin: "https://inspector.example" } });
		expect([preflight.status, preflight.headers.get("Access-Control-Allow-Origin")]).toEqual([204, "*"]);
		const metadata = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
		expect(metadata.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("keeps the cross-origin guard on every other API write", async () => {
		const response = await SELF.fetch(`${BASE}${API_ROUTES.createAgent.path}`, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
		expect(response.status).toBe(403);
	});
});

describe("Dynamic Client Registration", () => {
	it("registers a public client", async () => {
		const { status, body } = await register();
		expect(status).toBe(201);
		expect(body).toMatchObject({ client_id: expect.stringMatching(/^tfc_/), redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
	});

	it("limits registrations per IP", async () => {
		const ip = "203.0.113.200";
		for (let index = 0; index < 20; index++) expect((await register(undefined, ip)).status).toBe(201);
		const limited = await register(undefined, ip);
		expect([limited.status, limited.body.error]).toEqual([429, "slow_down"]);
	});

	it.each([
		["a plain-http remote redirect", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
		["a custom-scheme redirect", { redirect_uris: ["myapp://cb"] }, "invalid_redirect_uri"],
		["a redirect with a fragment", { redirect_uris: ["https://app.example/cb#x"] }, "invalid_redirect_uri"],
		["no redirect", { client_name: "x" }, "invalid_redirect_uri"],
		["a confidential client", { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
		["an unsupported grant", { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
	])("refuses %s", async (_name, body, error) => {
		const response = await register(body);
		expect([response.status, response.body.error]).toEqual([400, error]);
	});
});

describe("authorization", () => {
	it("describes the client and where it will send the person", async () => {
		const { body: client } = await register();
		const { challenge } = await pkce();
		const query = new URLSearchParams(authorizeParams(String(client.client_id), challenge));
		const response = await SELF.fetch(`${BASE}${API_ROUTES.describeAuthorization.path}?${query}`);
		expect(await response.json()).toEqual({
			ok: true,
			client: { name: "Claude Code", clientUri: null, verified: false, clientIdHost: null },
			redirectHost: "127.0.0.1:33418",
			redirectIsLocalhost: true,
		});
	});

	it("redirects with a code, the state and the issuer", async () => {
		const { redirect } = await approved();
		expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
		expect(redirect.searchParams.get("state")).toBe("xyz-state");
		expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
		expect(redirect.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("sends a refusal back with the state and the issuer", async () => {
		const person = await createAccount();
		const { body: client } = await register();
		const { challenge } = await pkce();
		const decision = await decide(person.id, { decision: "deny", params: authorizeParams(String(client.client_id), challenge) });
		const redirect = new URL(decision.body.redirectTo!);
		expect(Object.fromEntries(redirect.searchParams)).toMatchObject({ error: "access_denied", state: "xyz-state", iss: ORIGIN });
		expect(redirect.searchParams.has("code")).toBe(false);
	});

	it.each([
		["no PKCE", { code_challenge: "" }, "invalid_request"],
		["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
		["another resource", { resource: "https://other.example/mcp" }, "invalid_target"],
		["a token response type", { response_type: "token" }, "unsupported_response_type"],
	])("redirects an error for %s", async (_name, override, error) => {
		const { body: client } = await register();
		const { challenge } = await pkce();
		const query = new URLSearchParams(authorizeParams(String(client.client_id), challenge, override));
		const response = await SELF.fetch(`${BASE}${API_ROUTES.describeAuthorization.path}?${query}`);
		const body = (await response.json()) as { redirectTo: string };
		expect(new URL(body.redirectTo).searchParams.get("error")).toBe(error);
	});

	it.each([
		["an unknown client", { client_id: "tfc_doesnotexist" }],
		["an unregistered redirect", { redirect_uri: "https://evil.example/cb" }],
	])("never redirects for %s", async (_name, override) => {
		const { body: client } = await register();
		const { challenge } = await pkce();
		const query = new URLSearchParams(authorizeParams(String(client.client_id), challenge, override));
		const body = (await (await SELF.fetch(`${BASE}${API_ROUTES.describeAuthorization.path}?${query}`)).json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.redirectTo).toBeUndefined();
	});

	it("needs a signed-in person to approve", async () => {
		const { body: client } = await register();
		const { challenge } = await pkce();
		const decision = await decide(null, { decision: "approve", params: authorizeParams(String(client.client_id), challenge), name: "x", grants: [] });
		expect(decision.status).toBe(401);
	});

	it("refuses to grant a column the person cannot reach, creating nothing", async () => {
		const person = await createAccount();
		const someoneElse = await createColumn((await createAccount()).id);
		const { body: client } = await register();
		const { challenge } = await pkce();
		const decision = await decide(person.id, { decision: "approve", params: authorizeParams(String(client.client_id), challenge), name: "x", grants: [{ columnId: someoneElse, level: "edit" }] });
		expect(decision.status).toBe(409);
		expect(await listAgents(person.id)).toEqual([]);
	});

	it("refuses the same column twice", async () => {
		const person = await createAccount();
		const columnId = await createColumn(person.id);
		const { body: client } = await register();
		const { challenge } = await pkce();
		const grants = [
			{ columnId, level: "read" },
			{ columnId, level: "edit" },
		];
		const decision = await decide(person.id, { decision: "approve", params: authorizeParams(String(client.client_id), challenge), name: "x", grants });
		expect(decision.status).toBe(400);
		expect(await listAgents(person.id)).toEqual([]);
	});

	it("gives no code, and keeps no connection, when a chosen column cannot be granted", async () => {
		const person = await createAccount();
		const columnId = await createColumn(person.id);
		const { body: client } = await register();
		const { challenge } = await pkce();
		const decision = await withConnectionsAtGrantLimit(() =>
			decide(person.id, { decision: "approve", params: authorizeParams(String(client.client_id), challenge), name: "x", grants: [{ columnId, level: "edit" }] }),
		);
		expect(decision.status).toBe(409);
		expect(decision.body.redirectTo).toBeUndefined();
		expect(await listAgents(person.id)).toEqual([]);
	});
});

describe("tokens", () => {
	it.each(MCP_ERAS)("lets the approved client use exactly the granted column (%s protocol)", async (era) => {
		const flow = await approved("append");
		const issued = await exchange(flow);
		expect(issued.status).toBe(200);
		expect(issued.headers.get("Cache-Control")).toBe("no-store");
		expect(issued.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, access_token: expect.stringMatching(/^tfa_/), refresh_token: expect.stringMatching(/^tfr_/) });

		const listed = await callTool(String(issued.body.access_token), "list_columns", {}, { era });
		expect(listed.body?.result?.structuredContent).toEqual({ columns: [{ columnId: flow.columnId, title: "(untitled)", level: "append" }] });
		const [connection] = await listAgents(flow.person.id);
		expect(connection).toMatchObject({ name: "Claude Code", clientId: flow.clientId, grants: [{ columnId: flow.columnId, level: "append" }] });
	});

	it("rotates refresh tokens: each works once", async () => {
		const issued = await exchange(await approved()).then((r) => r.body);
		const flowClient = (await listAgents((await createAccount()).id)).length; // unrelated account sees nothing
		expect(flowClient).toBe(0);
		const clientId = String((await env.AUTH_DB.prepare(`SELECT "clientId" FROM "agent_connection" WHERE "id" = (SELECT "connectionId" FROM "agent_token" WHERE "kind" = 'refresh' ORDER BY "createdAt" DESC LIMIT 1)`).first<{ clientId: string }>())!.clientId);
		const first = await token({ grant_type: "refresh_token", refresh_token: String(issued.refresh_token), client_id: clientId });
		expect(first.status).toBe(200);
		expect(first.body.refresh_token).not.toBe(issued.refresh_token);
		const again = await token({ grant_type: "refresh_token", refresh_token: String(issued.refresh_token), client_id: clientId });
		expect([again.status, again.body.error]).toEqual([400, "invalid_grant"]);
		expect((await callTool(String(first.body.access_token), "list_columns")).status).toBe(200);
	});

	it("binds a refresh token to its client", async () => {
		const flow = await approved();
		const issued = (await exchange(flow)).body;
		const { body: other } = await register();
		const stolen = await token({ grant_type: "refresh_token", refresh_token: String(issued.refresh_token), client_id: String(other.client_id) });
		expect(stolen.body.error).toBe("invalid_grant");
	});

	it("never accepts a refresh token as an access token", async () => {
		const issued = (await exchange(await approved())).body;
		expect((await callTool(String(issued.refresh_token), "list_columns")).status).toBe(401);
	});

	it("revokes everything issued from a replayed code", async () => {
		const flow = await approved();
		const first = await exchange(flow);
		expect(first.status).toBe(200);
		const replay = await exchange(flow);
		expect(replay.body.error).toBe("invalid_grant");
		expect((await callTool(String(first.body.access_token), "list_columns")).status).toBe(401);
		expect(await listAgents(flow.person.id)).toEqual([]);
	});

	it.each([
		["the wrong verifier", { code_verifier: base64Url(crypto.getRandomValues(new Uint8Array(32))) }, "invalid_grant"],
		["a different redirect", { redirect_uri: "http://127.0.0.1:33418/other" }, "invalid_grant"],
		["another resource", { resource: "https://other.example/mcp" }, "invalid_target"],
		["an unsupported grant", { grant_type: "password" }, "unsupported_grant_type"],
	])("refuses a code exchange with %s", async (_name, override, error) => {
		const response = await exchange(await approved(), override);
		expect([response.status, response.body.error]).toEqual([400, error]);
	});

	it("refuses a code redeemed by another client", async () => {
		const flow = await approved();
		const { body: other } = await register();
		expect((await exchange(flow, { client_id: String(other.client_id) })).body.error).toBe("invalid_grant");
	});

	it("refuses an expired code", async () => {
		const flow = await approved();
		await env.AUTH_DB.prepare(`UPDATE "oauth_code" SET "expiresAt" = ?`).bind(Date.now() - 1).run();
		expect((await exchange(flow)).body.error).toBe("invalid_grant");
	});

	it("stops working when the person revokes the connection", async () => {
		const flow = await approved();
		const issued = (await exchange(flow)).body;
		const [connection] = await listAgents(flow.person.id);
		await agentStore(env.AUTH_DB).revoke(flow.person.id.replace(/\s/g, ""), connection!.id, Date.now());
		expect((await callTool(String(issued.access_token), "list_columns")).status).toBe(401);
		expect((await token({ grant_type: "refresh_token", refresh_token: String(issued.refresh_token), client_id: flow.clientId })).body.error).toBe("invalid_grant");
	});
});

describe("redirect URI rules", () => {
	it.each([
		["https://app.example/cb", true],
		["http://localhost:1234/cb", true],
		["http://127.0.0.1/cb", true],
		["http://[::1]:8080/cb", true],
		["http://app.example/cb", false],
		["myapp://cb", false],
		["https://user:pass@app.example/cb", false],
	])("%s allowed: %s", (uri, allowed) => {
		expect(isAllowedRedirectUri(uri)).toBe(allowed);
	});

	it("lets loopback redirects use any port, and nothing else vary", () => {
		expect(redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:5555/callback")).toBe(true);
		expect(redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:5555/other")).toBe(false);
		expect(redirectUriMatches("http://127.0.0.1:1234/callback", "http://localhost:1234/callback")).toBe(false);
		expect(redirectUriMatches("https://app.example:8443/cb", "https://app.example:9443/cb")).toBe(false);
	});
});

describe("Client ID Metadata Documents", () => {
	const CLIENT_ID = "https://client.example/oauth/metadata.json";
	const document = { client_id: CLIENT_ID, client_name: "Example Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };

	function fetcher(respond: (url: string) => Response) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetch: MetadataFetcher = async (url, init) => {
			calls.push({ url, init });
			return respond(url);
		};
		return { fetch, calls };
	}

	async function resolve(clientId: string, respond: (url: string) => Response) {
		const stub = fetcher(respond);
		const result = await oauthClients(env.AUTH_DB, stub.fetch).resolve(clientId, Date.now());
		return { result, calls: stub.calls };
	}

	it("accepts a valid document, fetched without following redirects", async () => {
		const { result, calls } = await resolve(`${CLIENT_ID}?v=1`.replace("?v=1", ""), () => Response.json(document));
		expect(result).toMatchObject({ ok: true, client: { kind: "metadata", name: "Example Client", redirectUris: [REDIRECT] } });
		expect(calls[0]!.init.redirect).toBe("manual");
		expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
	});

	it("caches a fetched document", async () => {
		const id = "https://client.example/cached.json";
		await resolve(id, () => Response.json({ ...document, client_id: id }));
		const { calls } = await resolve(id, () => Response.json({ ...document, client_id: id }));
		expect(calls).toHaveLength(0);
	});

	it.each<[string, string, (url: string) => Response]>([
		["a client_id that differs from its URL", "https://client.example/a.json", () => Response.json(document)],
		["a redirect", "https://client.example/b.json", () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } })],
		["an oversized document", "https://client.example/c.json", (url) => new Response(JSON.stringify({ ...document, client_id: url, padding: "x".repeat(6000) }))],
		["invalid JSON", "https://client.example/d.json", () => new Response("not json")],
		["no redirect_uris", "https://client.example/e.json", (url) => Response.json({ client_id: url, client_name: "x" })],
		["an unsafe redirect", "https://client.example/f.json", (url) => Response.json({ ...document, client_id: url, redirect_uris: ["http://evil.example/cb"] })],
		["a confidential client", "https://client.example/g.json", (url) => Response.json({ ...document, client_id: url, token_endpoint_auth_method: "private_key_jwt" })],
		[
			"a client that lists only confidential methods",
			"https://client.example/h.json",
			(url) => Response.json({ ...document, client_id: url, token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
		],
	])("refuses %s", async (_name, clientId, respond) => {
		const { result } = await resolve(clientId, respond);
		expect(result.ok).toBe(false);
	});

	it.each(["https://localhost/x.json", "https://127.0.0.1/x.json", "https://10.1.2.3/x.json", "https://192.168.0.5/x.json", "https://169.254.169.254/latest", "https://[::1]/x.json", "https://intranet/x.json", "https://printer.local/x.json", "http://client.example/x.json", "https://client.example"])(
		"never fetches %s",
		async (clientId) => {
			const { result, calls } = await resolve(clientId, () => Response.json(document));
			expect(result.ok).toBe(false);
			expect(calls).toHaveLength(0);
		},
	);

	it("accepts ChatGPT's published document, which prefers private_key_jwt but also lists none", async () => {
		// Verbatim from https://chatgpt.com/oauth/client.json on 2026-10-19.
		const chatgpt = {
			client_id: "https://chatgpt.com/oauth/client.json",
			client_uri: "https://chatgpt.com/",
			redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: "ChatGPT",
			logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
			token_endpoint_auth_signing_alg: "RS256",
			jwks_uri: "https://chatgpt.com/oauth/jwks.json",
		};
		const stub = fetcher(() => Response.json(chatgpt));
		const validation = await validateAuthorizationRequest(
			{ ...authorizeParams(chatgpt.client_id, (await pkce()).challenge), redirect_uri: chatgpt.redirect_uris[0] },
			ORIGIN,
			oauthClients(env.AUTH_DB, stub.fetch),
			Date.now(),
		);
		expect(validation).toMatchObject({ ok: true, request: { client: { clientId: chatgpt.client_id, name: "ChatGPT" }, redirectUri: chatgpt.redirect_uris[0] } });
	});

	it("authorizes a metadata client and shows where it is hosted", async () => {
		const stub = fetcher(() => Response.json(document));
		const validation = await validateAuthorizationRequest(
			{ ...authorizeParams(CLIENT_ID, (await pkce()).challenge) },
			ORIGIN,
			oauthClients(env.AUTH_DB, stub.fetch),
			Date.now() + 60 * 60 * 1000,
		);
		expect(validation).toMatchObject({ ok: true, request: { client: { clientId: CLIENT_ID, name: "Example Client" }, redirectUri: REDIRECT } });
	});
});
