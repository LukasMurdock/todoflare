import {
	decodeAttestationObject,
	isoBase64URL,
	parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import { namesAnotherAccount } from "../lib/account-request-headers";
import { AUTH_ROUTES, type ApiRoute } from "../lib/api/routes";
import { passkeyUser } from "../lib/passkey-identity";
import type { AuthErrorCode, AuthErrorEnvelope } from "../lib/api/errors";
import { readOnlyModeResponse } from "./read-only-mode";
import { rewriteJsonResponse } from "./http/responses";

/**
 * Who may call which better-auth endpoint, and what each one must prove
 * ([0017](../../docs/decisions/0017-verified-passkeys-and-recent-credential-changes.md)).
 * serveAuthEndpoint applies it; src/server/routes/auth.ts mounts that under
 * AUTH_BASE_PATH.
 */

/** How recently an account must have signed in to change its credentials. */
export const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;

/**
 * A passkey is an account's only everyday credential, so it must prove the
 * user (PIN or biometric) as well as the device. Registration asks for it in
 * the passkey plugin's config; sign-in options are rewritten to ask for it.
 */
export const USER_VERIFICATION = "required" as const;

export interface AuthEndpointPolicy {
	/** Still served while READ_ONLY_MODE freezes credential changes. */
	whileFrozen?: true;
	/**
	 * Needs a session created within RECENT_AUTHENTICATION_MS.
	 * - `always`
	 * - `unlessUnenrolled`: except for an account with no passkey and no
	 *   recovery code, which has nothing to sign in again with.
	 * - `byChallenge`: not checked here. The endpoint consumes a single-use,
	 *   short-lived challenge that only a checked endpoint issues, so checking
	 *   again could only fail a slow ceremony. better-auth's own freshness
	 *   check is off (auth.ts), so this policy is the only one.
	 */
	recentSignIn?: "always" | "unlessUnenrolled" | "byChallenge";
	/** Refused when the client names an account other than the session's. */
	expectedAccount?: true;
	/** Refused unless the authenticator data reports user verification. */
	userVerification?: "registration" | "authentication";
	/**
	 * The returned WebAuthn options are rewritten. `authentication` asks for
	 * USER_VERIFICATION, which the plugin only prefers. `registration` names
	 * the account with passkeyUser() instead of the plugin's random handle and
	 * the request's passkey label.
	 */
	webauthnOptions?: "authentication" | "registration";
	/** Refused if it would remove the account's last way to sign in. */
	keepsRecoveryMethod?: true;
}

const endpoint = (route: ApiRoute) => `${route.method} ${route.path}`;

/**
 * Every better-auth endpoint reachable over HTTP, by method and path relative
 * to AUTH_BASE_PATH. Anything else answers 404: the plugins define many more
 * (email, social, account linking, user updates) that Todoflare does not use.
 * test/auth-policy.test.ts checks each row against better-auth's endpoints.
 */
export const AUTH_ENDPOINTS: Readonly<Record<string, AuthEndpointPolicy>> = {
	"GET /get-session": { whileFrozen: true },
	"POST /sign-out": { whileFrozen: true },
	"POST /sign-in/anonymous": {},
	"POST /revoke-other-sessions": { expectedAccount: true },
	"GET /passkey/list-user-passkeys": { whileFrozen: true, expectedAccount: true },
	"GET /passkey/generate-authenticate-options": { whileFrozen: true, webauthnOptions: "authentication" },
	"POST /passkey/verify-authentication": { whileFrozen: true, userVerification: "authentication" },
	"GET /passkey/generate-register-options": { recentSignIn: "unlessUnenrolled", expectedAccount: true, webauthnOptions: "registration" },
	"POST /passkey/verify-registration": { recentSignIn: "byChallenge", expectedAccount: true, userVerification: "registration" },
	"POST /passkey/delete-passkey": { recentSignIn: "always", expectedAccount: true, keepsRecoveryMethod: true },
	[endpoint(AUTH_ROUTES.generateRecoveryCode)]: { recentSignIn: "always", expectedAccount: true },
	[endpoint(AUTH_ROUTES.recoverAccount)]: {},
};

export function authEndpointPolicy(method: string, path: string): AuthEndpointPolicy | undefined {
	return Object.hasOwn(AUTH_ENDPOINTS, `${method} ${path}`) ? AUTH_ENDPOINTS[`${method} ${path}`] : undefined;
}

/** What each refusal means to the client; one entry per AUTH_ERROR_CODES. */
const AUTH_ERRORS = {
	unauthorized: { status: 401, message: "Sign in first" },
	not_found: { status: 404, message: "Not found" },
	account_mismatch: { status: 401, message: "Another account signed in on this device. Reload to continue." },
	recent_authentication_required: { status: 401, message: "Confirm it's you with a passkey, then try again" },
	last_recovery_method: { status: 409, message: "Add another passkey or a recovery code before removing this one" },
	user_verification_required: { status: 400, message: "Your passkey must confirm it's you with a PIN, fingerprint or face" },
} as const satisfies Record<AuthErrorCode, { status: number; message: string }>;

/**
 * The refusal for a credential change from a session that is not a recent
 * sign-in. Agent routes outside AUTH_BASE_PATH answer with it too.
 */
export const recentSignInRequired = () => authError("recent_authentication_required");

function authError(code: AuthErrorCode): Response {
	const { status, message } = AUTH_ERRORS[code];
	const body: AuthErrorEnvelope = { error: code, code, message };
	return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** The credentials an account can sign in with. */
export interface CredentialInventory {
	passkeys: number;
	recoveryCode: boolean;
}

export async function credentialInventory(db: D1Database, accountId: string): Promise<CredentialInventory> {
	const row = await db.prepare(
		`SELECT
		   (SELECT COUNT(*) FROM "passkey" WHERE "userId" = ?1) AS passkeys,
		   (SELECT "recoveryCodeHash" IS NOT NULL FROM "user" WHERE "id" = ?1) AS recoveryCode`,
	)
		.bind(accountId)
		.first<{ passkeys: number; recoveryCode: number | null }>();
	return { passkeys: row?.passkeys ?? 0, recoveryCode: row?.recoveryCode === 1 };
}

/**
 * A sign-up that has not added its passkey: it cannot sync, share or create a
 * recovery code. `isAnonymous` is not trusted for this; a passkey row is.
 */
export const isProvisional = (inventory: CredentialInventory) => inventory.passkeys === 0;

/** Nothing to sign in again with: a sign-up that has not added its passkey. */
export const isUnenrolled = (inventory: CredentialInventory) =>
	inventory.passkeys === 0 && !inventory.recoveryCode;

/** Removing one passkey would leave no way to sign in. */
export const isLastRecoveryMethod = (inventory: CredentialInventory) =>
	inventory.passkeys <= 1 && !inventory.recoveryCode;

/** Session age, not activity: rolling refresh never makes a session recent. */
export function isRecentSession(createdAt: Date | string | number, now = Date.now()): boolean {
	return now - new Date(createdAt).getTime() <= RECENT_AUTHENTICATION_MS;
}

function authenticatorData(ceremony: "registration" | "authentication", body: unknown): Uint8Array<ArrayBuffer> | null {
	const response = (body as { response?: { response?: Record<string, unknown> } } | null)?.response?.response;
	if (!response) return null;
	if (ceremony === "authentication") {
		const encoded = response.authenticatorData;
		return typeof encoded === "string" ? isoBase64URL.toBuffer(encoded) : null;
	}
	const encoded = response.attestationObject;
	if (typeof encoded !== "string") return null;
	const data = decodeAttestationObject(isoBase64URL.toBuffer(encoded)).get("authData");
	return data ? new Uint8Array(data) : null;
}

/**
 * better-auth's passkey plugin verifies signatures but hard-codes
 * `requireUserVerification: false`; this reads the UV flag from the same
 * authenticator data. At sign-in the assertion signature covers the flag; at
 * registration, with "none" attestation, it is what the browser reports.
 */
export function userVerified(ceremony: "registration" | "authentication", body: unknown): boolean {
	try {
		const data = authenticatorData(ceremony, body);
		if (!data) return false;
		return parseAuthenticatorData(data).flags.uv === true;
	} catch {
		return false;
	}
}

interface PolicySession {
	user: { id: string };
	session: { createdAt: Date | string | number };
}

export interface AuthRequest {
	request: Request;
	/** Path relative to AUTH_BASE_PATH. */
	path: string;
	db: D1Database;
	/** READ_ONLY_MODE is on. */
	frozen: boolean;
	session: () => Promise<PolicySession | null>;
	/** better-auth's handler, called only once the policy allows the request. */
	handle: () => Promise<Response>;
}

/**
 * Serves one request under AUTH_BASE_PATH by its AUTH_ENDPOINTS row: every
 * field of AuthEndpointPolicy is interpreted here and nowhere else.
 */
export async function serveAuthEndpoint(auth: AuthRequest): Promise<Response> {
	const policy = authEndpointPolicy(auth.request.method, auth.path);
	if (auth.frozen && !policy?.whileFrozen) return readOnlyModeResponse();
	if (!policy) return authError("not_found");
	const refused = await refusal(policy, auth);
	if (refused) return authError(refused);
	const response = await auth.handle();
	if (!policy.webauthnOptions || !response.ok) return response;
	if (policy.webauthnOptions === "authentication") {
		return rewriteJsonResponse(response, (options) => ({ ...options, userVerification: USER_VERIFICATION }));
	}
	const current = await auth.session();
	return current ? rewriteJsonResponse(response, (options) => ({ ...options, user: passkeyUser(current.user.id) })) : response;
}

async function refusal(policy: AuthEndpointPolicy, { request, db, session }: AuthRequest): Promise<AuthErrorCode | null> {
	const checksRecency = policy.recentSignIn === "always" || policy.recentSignIn === "unlessUnenrolled";
	if (policy.expectedAccount || checksRecency || policy.keepsRecoveryMethod) {
		const current = await session();
		if (!current) return "unauthorized";
		if (policy.expectedAccount && namesAnotherAccount(request.headers, current.user.id)) return "account_mismatch";
		if (checksRecency || policy.keepsRecoveryMethod) {
			const inventory = await credentialInventory(db, current.user.id);
			const exempt = policy.recentSignIn === "unlessUnenrolled" && isUnenrolled(inventory);
			if (checksRecency && !exempt && !isRecentSession(current.session.createdAt)) return "recent_authentication_required";
			if (policy.keepsRecoveryMethod && isLastRecoveryMethod(inventory)) return "last_recovery_method";
		}
	}
	if (policy.userVerification) {
		const body = await request.clone().json().catch(() => null);
		if (!userVerified(policy.userVerification, body)) return "user_verification_required";
	}
	return null;
}
