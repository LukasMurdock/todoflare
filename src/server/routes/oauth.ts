import { z } from "zod";
import { AGENT_CONNECTION_DEFAULT_DAYS, AGENT_CONNECTION_MAX_DAYS, initialAgentGrantsSchema } from "../../lib/api/agent-contract";
import { API_ROUTES } from "../../lib/api/routes";
import { hasColumnAccess } from "../../lib/column-access";
import { requireAccountCredential } from "../../lib/http-account-auth";
import { checkRateLimit, getClientIP, ipRateLimitKey, RATE_LIMITS } from "../../lib/rate-limit";
import { loadColumnAccessState } from "../agent-access/column-state";
import { agentStore } from "../agent-access/store";
import { blockWritesIfReadOnly, shouldSkipRateLimit } from "../http/guards";
import { validateJsonBody } from "../http/request-validation";
import {
	authorizationCodes,
	authorizationParamsSchema,
	authorizationRedirect,
	authorizationServerMetadata,
	clientRegistrationSchema,
	isLoopbackRedirect,
	isOwnResource,
	oauthClients,
	protectedResourceMetadata,
	validateAuthorizationRequest,
} from "../oauth/authorization-server";
import { isAgentAccessEnabled } from "./agents";
import type { App, AppContext } from "../bindings";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
/** Discovery, registration and token endpoints serve browser-based clients on other origins. */
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
	"Access-Control-Max-Age": "86400",
};

function origin(c: AppContext): string {
	return new URL(c.req.url).origin;
}

/** Client metadata documents are fetched with the Worker's own fetch. */
function clients(c: AppContext) {
	return oauthClients(c.env.AUTH_DB, (url, init) => fetch(url, init));
}

function oauthError(error: string, description: string, status = 400): Response {
	return Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...CORS } });
}

async function rateLimited(c: AppContext, action: "oauth-register" | "oauth-token", config: { limit: number; windowSeconds: number }) {
	if (shouldSkipRateLimit(c)) return null;
	const result = await checkRateLimit(c.env.RATE_LIMIT_COORDINATOR, ipRateLimitKey(action, getClientIP(c.req.raw)), config);
	return result.allowed ? null : oauthError("slow_down", "Too many requests", 429);
}

const decisionSchema = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("deny"), params: authorizationParamsSchema }).strict(),
	z
		.object({
			decision: z.literal("approve"),
			params: authorizationParamsSchema,
			name: z.string().trim().min(1).max(80),
			expiresInDays: z.number().int().min(1).max(AGENT_CONNECTION_MAX_DAYS).default(AGENT_CONNECTION_DEFAULT_DAYS),
			grants: initialAgentGrantsSchema,
		})
		.strict(),
]);

export function registerOAuthRoutes(app: App) {
	const disabled = () => Response.json({ error: "Not found", code: "not_found" }, { status: 404 });

	for (const path of [API_ROUTES.oauthProtectedResource.path, API_ROUTES.oauthProtectedResourceMcp.path]) {
		app.on("GET", path, (c) => (isAgentAccessEnabled(c.env) ? c.json(protectedResourceMetadata(origin(c)), 200, CORS) : disabled()));
	}
	app.on(API_ROUTES.oauthAuthorizationServer.method, API_ROUTES.oauthAuthorizationServer.path, (c) =>
		isAgentAccessEnabled(c.env) ? c.json(authorizationServerMetadata(origin(c)), 200, CORS) : disabled(),
	);
	for (const path of [
		API_ROUTES.oauthProtectedResource.path,
		API_ROUTES.oauthProtectedResourceMcp.path,
		API_ROUTES.oauthAuthorizationServer.path,
		API_ROUTES.oauthRegister.path,
		API_ROUTES.oauthToken.path,
	]) {
		app.on("OPTIONS", path, () => new Response(null, { status: 204, headers: CORS }));
	}

	// Dynamic Client Registration (RFC 7591). Deprecated in MCP 2026-07-28 in
	// favour of Client ID Metadata Documents, and kept because clients use it.
	app.on(API_ROUTES.oauthRegister.method, API_ROUTES.oauthRegister.path, async (c) => {
		if (!isAgentAccessEnabled(c.env)) return disabled();
		const limited = await rateLimited(c, "oauth-register", RATE_LIMITS.oauthRegister);
		if (limited) return limited;
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return oauthError("invalid_client_metadata", "Body must be JSON");
		}
		const parsed = clientRegistrationSchema.safeParse(body);
		if (!parsed.success) {
			const redirect = parsed.error.issues.some((issue) => issue.path[0] === "redirect_uris");
			return oauthError(redirect ? "invalid_redirect_uri" : "invalid_client_metadata", parsed.error.issues.map((issue) => issue.message).join("; "));
		}
		const registered = await clients(c).register(parsed.data, Date.now());
		if (!registered.ok) return oauthError(registered.error, registered.description);
		const { client } = registered;
		return Response.json(
			{
				client_id: client.clientId,
				client_id_issued_at: Math.floor(Date.now() / 1000),
				client_name: client.name,
				redirect_uris: client.redirectUris,
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			},
			{ status: 201, headers: { ...NO_STORE, ...CORS } },
		);
	});

	// What the consent page shows: who is asking and where it will send you.
	app.on(API_ROUTES.describeAuthorization.method, API_ROUTES.describeAuthorization.path, async (c) => {
		if (!isAgentAccessEnabled(c.env)) return disabled();
		const params = authorizationParamsSchema.safeParse(c.req.query());
		if (!params.success) return c.json({ ok: false, display: "This authorization request is malformed." }, 400, NO_STORE);
		const validation = await validateAuthorizationRequest(params.data, origin(c), clients(c), Date.now());
		if (!validation.ok) return c.json(validation, 400, NO_STORE);
		const { client, redirectUri } = validation.request;
		return c.json(
			{
				ok: true,
				client: {
					name: client.name,
					clientUri: client.clientUri,
					verified: client.kind === "metadata",
					clientIdHost: client.kind === "metadata" ? new URL(client.clientId).host : null,
				},
				redirectHost: new URL(redirectUri).host,
				redirectIsLocalhost: isLoopbackRedirect(redirectUri),
			},
			200,
			NO_STORE,
		);
	});

	// The person's decision. Approval creates the connection and its grants,
	// then a single-use code bound to this client, redirect, PKCE challenge and resource.
	app.on(API_ROUTES.decideAuthorization.method, API_ROUTES.decideAuthorization.path, async (c) => {
		if (!isAgentAccessEnabled(c.env)) return disabled();
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, decisionSchema);
		if (!body.ok) return body.response;
		const now = Date.now();
		const validation = await validateAuthorizationRequest(body.data.params, origin(c), clients(c), now);
		if (!validation.ok) return c.json(validation, 400, NO_STORE);
		const { request } = validation;
		if (body.data.decision === "deny") {
			return c.json(
				{ redirectTo: authorizationRedirect(request.redirectUri, origin(c), { error: "access_denied", error_description: "The person declined", state: request.state }) },
				200,
				NO_STORE,
			);
		}
		const readOnly = blockWritesIfReadOnly(c);
		if (readOnly) return readOnly;
		const { name, expiresInDays, grants } = body.data;
		// An account can delegate only what it can reach itself, right now.
		for (const grant of grants) {
			const column = await loadColumnAccessState(c.env.COLUMN_ROOM, grant.columnId);
			if (!column.ok || !column.state || column.state.trashed || !hasColumnAccess(column.state.meta, auth.accountId)) {
				return c.json({ ok: false, display: "One of the chosen columns is no longer available. Reload and try again." }, 409, NO_STORE);
			}
		}
		const store = agentStore(c.env.AUTH_DB);
		const created = await store.createForClient({ userId: auth.accountId, name, expiresInDays, clientId: request.client.clientId, now });
		if (!created.ok) {
			return c.json({ ok: false, display: "You already have the maximum number of connected agents. Remove one first." }, 409, NO_STORE);
		}
		for (const grant of grants) {
			const granted = await store.setGrant({ userId: auth.accountId, connectionId: created.value.id, columnId: grant.columnId, level: grant.level, expiresAt: null, now });
			if (!granted.ok) {
				// Never hand out a code for fewer columns than the person approved.
				await store.revokeById(created.value.id, now);
				return c.json({ ok: false, display: "The chosen columns could not all be granted. Reload and try again." }, 409, NO_STORE);
			}
		}
		const code = await authorizationCodes(c.env.AUTH_DB).create(request, created.value.id, now);
		return c.json({ redirectTo: authorizationRedirect(request.redirectUri, origin(c), { code, state: request.state }) }, 200, NO_STORE);
	});

	app.on(API_ROUTES.oauthToken.method, API_ROUTES.oauthToken.path, async (c) => {
		if (!isAgentAccessEnabled(c.env)) return disabled();
		const limited = await rateLimited(c, "oauth-token", RATE_LIMITS.oauthToken);
		if (limited) return limited;
		const contentType = c.req.header("Content-Type") ?? "";
		let form: Record<string, string>;
		try {
			form = contentType.includes("application/json")
				? ((await c.req.json()) as Record<string, string>)
				: Object.fromEntries(new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer())));
		} catch {
			return oauthError("invalid_request", "Unreadable token request");
		}
		const field = (key: string) => (typeof form[key] === "string" ? form[key] : undefined);
		const clientId = field("client_id");
		if (!clientId) return oauthError("invalid_client", "client_id is required", 401);
		const now = Date.now();
		const store = agentStore(c.env.AUTH_DB);
		const tokens = (issued: Awaited<ReturnType<typeof store.issueTokens>>) =>
			Response.json(
				{ access_token: issued.accessToken, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refreshToken },
				{ headers: { ...NO_STORE, ...CORS } },
			);

		switch (field("grant_type")) {
			case "authorization_code": {
				const code = field("code");
				const verifier = field("code_verifier");
				if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required");
				const redeemed = await authorizationCodes(c.env.AUTH_DB).redeem({
					code,
					clientId,
					redirectUri: field("redirect_uri"),
					codeVerifier: verifier,
					resource: field("resource"),
					origin: origin(c),
					now,
				});
				if (!redeemed.ok) {
					// A replayed code may have been stolen: revoke everything issued from it.
					if (redeemed.replayedConnectionId) await store.revokeById(redeemed.replayedConnectionId, now);
					return oauthError(redeemed.description.includes("MCP endpoint") ? "invalid_target" : "invalid_grant", redeemed.description);
				}
				const connection = await c.env.AUTH_DB.prepare(`SELECT "expiresAt" FROM "agent_connection" WHERE "id" = ? AND "revokedAt" IS NULL`)
					.bind(redeemed.connectionId)
					.first<{ expiresAt: number }>();
				if (!connection || connection.expiresAt <= now) return oauthError("invalid_grant", "This authorization was revoked");
				return tokens(await store.issueTokens(redeemed.connectionId, connection.expiresAt, now));
			}
			case "refresh_token": {
				const refresh = field("refresh_token");
				if (!refresh) return oauthError("invalid_request", "refresh_token is required");
				const resource = field("resource");
				if (resource !== undefined && !isOwnResource(resource, origin(c))) {
					return oauthError("invalid_target", "Tokens can only be issued for this server's MCP endpoint");
				}
				const connection = await store.redeemRefreshToken(refresh, clientId, now);
				if (!connection) return oauthError("invalid_grant", "Refresh token is invalid, expired, revoked or already used");
				return tokens(await store.issueTokens(connection.id, connection.expiresAt, now));
			}
			default:
				return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
		}
	});
}
