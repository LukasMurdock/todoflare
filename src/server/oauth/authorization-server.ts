import { z } from "zod";
import { API_ROUTES, OAUTH_AUTHORIZE_PAGE_PATH } from "../../lib/api/routes";

/**
 * OAuth 2.1 authorization server for MCP clients, per the MCP 2026-07-28
 * authorization specification: public clients only, authorization code with
 * mandatory S256 PKCE, RFC 8707 resource binding, RFC 9207 `iss` on every
 * redirect, and clients identified by Client ID Metadata Documents (preferred)
 * or Dynamic Client Registration (deprecated, kept for compatibility).
 *
 * The user's consent is not a scope list: it is the choice of columns and
 * levels, which become the connection's grants.
 */

const CODE_TTL_MS = 2 * 60 * 1000;
const METADATA_CACHE_MS = 10 * 60 * 1000;
const METADATA_MAX_BYTES = 5 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
const MAX_REDIRECT_URIS = 10;

export function mcpResourceUrl(origin: string): string {
	return `${origin}${API_ROUTES.mcp.path}`;
}

export function protectedResourceMetadataUrl(origin: string): string {
	return `${origin}/.well-known/oauth-protected-resource${API_ROUTES.mcp.path}`;
}

export function protectedResourceMetadata(origin: string) {
	return {
		resource: mcpResourceUrl(origin),
		authorization_servers: [origin],
		bearer_methods_supported: ["header"],
		resource_name: "Todoflare",
	};
}

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PAGE_PATH}`,
		token_endpoint: `${origin}${API_ROUTES.oauthToken.path}`,
		registration_endpoint: `${origin}${API_ROUTES.oauthRegister.path}`,
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
	};
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirect URIs must be HTTPS or loopback HTTP, without fragments or credentials. */
export function isAllowedRedirectUri(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.hash || url.username || url.password) return false;
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function isLoopbackRedirect(value: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(value).hostname);
	} catch {
		return false;
	}
}

/**
 * Exact match, except that loopback redirects may use any port (RFC 8252
 * §7.3): native apps bind an ephemeral port each time they sign in.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
	if (registered === presented) return true;
	try {
		const left = new URL(registered);
		const right = new URL(presented);
		return (
			left.protocol === "http:" &&
			LOOPBACK_HOSTS.has(left.hostname) &&
			left.hostname === right.hostname &&
			left.protocol === right.protocol &&
			left.pathname === right.pathname &&
			left.search === right.search
		);
	} catch {
		return false;
	}
}

function canonicalResource(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.hash) return null;
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
	} catch {
		return null;
	}
}

/** RFC 8707: tokens are only ever issued for this server's MCP endpoint. */
export function isOwnResource(value: string, origin: string): boolean {
	const resource = canonicalResource(value);
	return resource !== null && (resource === canonicalResource(mcpResourceUrl(origin)) || resource === canonicalResource(origin));
}

export interface OAuthClient {
	clientId: string;
	kind: "registered" | "metadata";
	name: string;
	clientUri: string | null;
	redirectUris: string[];
}

interface ClientRow {
	clientId: string;
	kind: "registered" | "metadata";
	name: string;
	clientUri: string | null;
	redirectUris: string;
	createdAt: number;
	fetchedAt: number | null;
}

function toClient(row: ClientRow): OAuthClient {
	return { clientId: row.clientId, kind: row.kind, name: row.name, clientUri: row.clientUri, redirectUris: JSON.parse(row.redirectUris) as string[] };
}

const clientNameSchema = z.string().trim().min(1).max(100);
const redirectUrisSchema = z
	.array(z.string().max(2000).refine(isAllowedRedirectUri, "Redirect URIs must use https, or http on localhost"))
	.min(1)
	.max(MAX_REDIRECT_URIS);

export const clientRegistrationSchema = z
	.object({
		redirect_uris: redirectUrisSchema,
		client_name: clientNameSchema.optional(),
		client_uri: z.string().url().max(2000).optional(),
		grant_types: z.array(z.string()).optional(),
		response_types: z.array(z.string()).optional(),
		token_endpoint_auth_method: z.string().optional(),
		application_type: z.enum(["native", "web"]).optional(),
	})
	.passthrough();

const metadataDocumentSchema = z
	.object({
		client_id: z.string(),
		client_name: clientNameSchema,
		client_uri: z.string().url().max(2000).optional(),
		redirect_uris: redirectUrisSchema,
		token_endpoint_auth_method: z.string().optional(),
	})
	.passthrough();

/** A client_id that names a metadata document: HTTPS with a path. */
export function isMetadataClientId(clientId: string): boolean {
	try {
		const url = new URL(clientId);
		return url.protocol === "https:" && url.pathname.length > 1 && !url.hash && !url.username && !url.password;
	} catch {
		return false;
	}
}

/**
 * Hosts a metadata fetch may never reach (SSRF): loopback, private and
 * link-local networks, and names that only resolve inside a network.
 * Workers cannot reach private networks in production; this also holds in
 * local development and under any future network configuration.
 */
function isForbiddenMetadataHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
	if (!host.includes(".") && !host.includes(":")) return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
	}
	// Any IPv6 literal: none is a legitimate place to host client metadata.
	return host.includes(":");
}

export type ClientLookup = { ok: true; client: OAuthClient } | { ok: false; description: string };

export type MetadataFetcher = (url: string, init: RequestInit) => Promise<Response>;

async function fetchMetadataDocument(clientId: string, fetcher: MetadataFetcher): Promise<ClientLookup> {
	if (isForbiddenMetadataHost(new URL(clientId).hostname)) return { ok: false, description: "Client metadata host is not allowed" };
	let response: Response;
	try {
		response = await fetcher(clientId, {
			headers: { Accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, description: "Client metadata could not be fetched" };
	}
	if (response.status !== 200) return { ok: false, description: `Client metadata request returned ${response.status}` };
	const declared = Number(response.headers.get("Content-Length") ?? "0");
	if (declared > METADATA_MAX_BYTES) return { ok: false, description: "Client metadata is too large" };
	const reader = response.body?.getReader();
	if (!reader) return { ok: false, description: "Client metadata is empty" };
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > METADATA_MAX_BYTES) {
			await reader.cancel();
			return { ok: false, description: "Client metadata is too large" };
		}
		chunks.push(value);
	}
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))));
	} catch {
		return { ok: false, description: "Client metadata is not valid JSON" };
	}
	const parsed = metadataDocumentSchema.safeParse(json);
	if (!parsed.success) return { ok: false, description: "Client metadata is missing client_id, client_name or valid redirect_uris" };
	if (parsed.data.client_id !== clientId) return { ok: false, description: "Client metadata client_id does not match its URL" };
	if (parsed.data.token_endpoint_auth_method && parsed.data.token_endpoint_auth_method !== "none") {
		return { ok: false, description: "Only public clients (token_endpoint_auth_method none) are supported" };
	}
	return {
		ok: true,
		client: { clientId, kind: "metadata", name: parsed.data.client_name, clientUri: parsed.data.client_uri ?? null, redirectUris: parsed.data.redirect_uris },
	};
}

export function oauthClients(db: D1Database, fetcher: MetadataFetcher) {
	return {
		async register(input: z.output<typeof clientRegistrationSchema>, now: number): Promise<{ ok: true; client: OAuthClient } | { ok: false; error: string; description: string }> {
			if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none") {
				return { ok: false, error: "invalid_client_metadata", description: "Only public clients (token_endpoint_auth_method none) are supported" };
			}
			if (input.grant_types?.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
				return { ok: false, error: "invalid_client_metadata", description: "Only authorization_code and refresh_token grants are supported" };
			}
			if (input.response_types?.some((type) => type !== "code")) {
				return { ok: false, error: "invalid_client_metadata", description: "Only the code response type is supported" };
			}
			const bytes = crypto.getRandomValues(new Uint8Array(16));
			const clientId = `tfc_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
			const client: OAuthClient = {
				clientId,
				kind: "registered",
				name: input.client_name ?? new URL(input.redirect_uris[0]!).host,
				clientUri: input.client_uri ?? null,
				redirectUris: input.redirect_uris,
			};
			await db
				.prepare(`INSERT INTO "oauth_client" ("clientId", "kind", "name", "clientUri", "redirectUris", "createdAt") VALUES (?, 'registered', ?, ?, ?, ?)`)
				.bind(clientId, client.name, client.clientUri, JSON.stringify(client.redirectUris), now)
				.run();
			return { ok: true, client };
		},

		/** A registered client, or a metadata-document client fetched (and cached) from its URL. */
		async resolve(clientId: string, now: number): Promise<ClientLookup> {
			const row = await db.prepare(`SELECT * FROM "oauth_client" WHERE "clientId" = ?`).bind(clientId).first<ClientRow>();
			if (row?.kind === "registered") return { ok: true, client: toClient(row) };
			if (!isMetadataClientId(clientId)) return { ok: false, description: "Unknown client_id" };
			if (row && row.fetchedAt !== null && now - row.fetchedAt < METADATA_CACHE_MS) return { ok: true, client: toClient(row) };
			const fetched = await fetchMetadataDocument(clientId, fetcher);
			if (!fetched.ok) return fetched;
			await db
				.prepare(
					`INSERT INTO "oauth_client" ("clientId", "kind", "name", "clientUri", "redirectUris", "createdAt", "fetchedAt")
					 VALUES (?, 'metadata', ?, ?, ?, ?, ?)
					 ON CONFLICT ("clientId") DO UPDATE SET "name" = excluded."name", "clientUri" = excluded."clientUri",
					   "redirectUris" = excluded."redirectUris", "fetchedAt" = excluded."fetchedAt"`,
				)
				.bind(clientId, fetched.client.name, fetched.client.clientUri, JSON.stringify(fetched.client.redirectUris), now, now)
				.run();
			return fetched;
		},
	};
}

/** The parameters of an authorization request, as the consent page passes them back. */
export const authorizationParamsSchema = z.object({
	response_type: z.string().optional(),
	client_id: z.string().max(2000).optional(),
	redirect_uri: z.string().max(2000).optional(),
	code_challenge: z.string().optional(),
	code_challenge_method: z.string().optional(),
	state: z.string().max(2000).optional(),
	resource: z.string().max(2000).optional(),
	scope: z.string().max(2000).optional(),
});
export type AuthorizationParams = z.output<typeof authorizationParamsSchema>;

export interface ValidAuthorization {
	client: OAuthClient;
	redirectUri: string;
	codeChallenge: string;
	state: string | null;
	resource: string;
}

/**
 * Either valid, or an error to show the user (when the client or redirect is
 * not trustworthy, nothing may be sent to it) or to redirect back with.
 */
export type AuthorizationValidation =
	| { ok: true; request: ValidAuthorization }
	| { ok: false; display: string }
	| { ok: false; redirectTo: string; display: string };

export function authorizationRedirect(
	redirectUri: string,
	origin: string,
	params: Record<string, string | null | undefined>,
): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
	url.searchParams.set("iss", origin);
	return url.toString();
}

export async function validateAuthorizationRequest(
	params: AuthorizationParams,
	origin: string,
	clients: ReturnType<typeof oauthClients>,
	now: number,
): Promise<AuthorizationValidation> {
	if (!params.client_id) return { ok: false, display: "The app did not identify itself (client_id is missing)." };
	const lookup = await clients.resolve(params.client_id, now);
	if (!lookup.ok) return { ok: false, display: `This app could not be verified: ${lookup.description}.` };
	const { client } = lookup;
	// With one registered redirect URI, an omitted redirect_uri means that one.
	const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : undefined);
	if (!redirectUri || !client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) {
		return { ok: false, display: "This app asked to return to an address it has not registered." };
	}
	const fail = (error: string, description: string): AuthorizationValidation => ({
		ok: false,
		display: description,
		redirectTo: authorizationRedirect(redirectUri, origin, { error, error_description: description, state: params.state }),
	});
	if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
	if (!params.code_challenge || params.code_challenge_method !== "S256") {
		return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
	}
	if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) return fail("invalid_request", "Malformed code_challenge");
	if (params.resource !== undefined && !isOwnResource(params.resource, origin)) {
		return fail("invalid_target", "Tokens can only be issued for this server's MCP endpoint");
	}
	return {
		ok: true,
		request: { client, redirectUri, codeChallenge: params.code_challenge, state: params.state ?? null, resource: mcpResourceUrl(origin) },
	};
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
	return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

export function authorizationCodes(db: D1Database) {
	return {
		async create(request: ValidAuthorization, connectionId: string, now: number): Promise<string> {
			const code = base64Url(crypto.getRandomValues(new Uint8Array(32)));
			await db
				.prepare(
					`INSERT INTO "oauth_code" ("codeHash", "clientId", "redirectUri", "codeChallenge", "resource", "connectionId", "expiresAt")
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(await sha256(code), request.client.clientId, request.redirectUri, request.codeChallenge, request.resource, connectionId, now + CODE_TTL_MS)
				.run();
			// An approval whose code was never redeemed left a connection no app can use.
			await db.batch([
				db
					.prepare(
						`UPDATE "agent_connection" SET "revokedAt" = ? WHERE "revokedAt" IS NULL AND "id" IN
						 (SELECT "connectionId" FROM "oauth_code" WHERE "usedAt" IS NULL AND "expiresAt" < ?)`,
					)
					.bind(now, now),
				db.prepare(`DELETE FROM "oauth_code" WHERE "expiresAt" < ?`).bind(now),
			]);
			return code;
		},

		/**
		 * Redeems a code exactly once. A replayed code reports its connection,
		 * so the caller can revoke everything issued from it (OAuth 2.1 §4.1.3).
		 */
		async redeem(input: {
			code: string;
			clientId: string;
			redirectUri: string | undefined;
			codeVerifier: string;
			resource: string | undefined;
			origin: string;
			now: number;
		}): Promise<{ ok: true; connectionId: string } | { ok: false; replayedConnectionId?: string; description: string }> {
			const hash = await sha256(input.code);
			const row = await db
				.prepare(`SELECT * FROM "oauth_code" WHERE "codeHash" = ?`)
				.bind(hash)
				.first<{ clientId: string; redirectUri: string; codeChallenge: string; resource: string; connectionId: string; expiresAt: number; usedAt: number | null }>();
			if (!row) return { ok: false, description: "Unknown authorization code" };
			if (row.usedAt !== null) return { ok: false, replayedConnectionId: row.connectionId, description: "Authorization code already used" };
			const claimed = await db
				.prepare(`UPDATE "oauth_code" SET "usedAt" = ? WHERE "codeHash" = ? AND "usedAt" IS NULL`)
				.bind(input.now, hash)
				.run();
			if (claimed.meta.changes !== 1) return { ok: false, replayedConnectionId: row.connectionId, description: "Authorization code already used" };
			if (row.expiresAt <= input.now) return { ok: false, description: "Authorization code expired" };
			if (row.clientId !== input.clientId) return { ok: false, description: "Authorization code was issued to another client" };
			if (input.redirectUri !== undefined && input.redirectUri !== row.redirectUri) return { ok: false, description: "redirect_uri does not match the authorization request" };
			if (input.resource !== undefined && !isOwnResource(input.resource, input.origin)) return { ok: false, description: "Tokens can only be issued for this server's MCP endpoint" };
			if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) || (await sha256(input.codeVerifier)) !== row.codeChallenge) {
				return { ok: false, description: "PKCE verification failed" };
			}
			return { ok: true, connectionId: row.connectionId };
		},
	};
}
