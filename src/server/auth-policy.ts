import {
	decodeAttestationObject,
	isoBase64URL,
	parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import { namesAnotherAccount } from "../lib/account-request-headers";
import { AUTH_ROUTES, type ApiRoute } from "../lib/api/routes";
import type { AuthErrorCode, AuthErrorEnvelope } from "../lib/api/errors";

/**
 * Who may call which better-auth endpoint, and what each one must prove
 * ([0017](../../docs/decisions/0017-verified-passkeys-and-recent-credential-changes.md)).
 * src/server/routes/auth.ts applies it to every request under AUTH_BASE_PATH.
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
	/** The returned options are rewritten to ask for USER_VERIFICATION. */
	requestsUserVerification?: true;
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
	"GET /passkey/list-user-passkeys": { whileFrozen: true },
	"GET /passkey/generate-authenticate-options": { whileFrozen: true, requestsUserVerification: true },
	"POST /passkey/verify-authentication": { whileFrozen: true, userVerification: "authentication" },
	"GET /passkey/generate-register-options": { recentSignIn: "unlessUnenrolled", expectedAccount: true },
	"POST /passkey/verify-registration": { recentSignIn: "byChallenge", expectedAccount: true, userVerification: "registration" },
	"POST /passkey/delete-passkey": { recentSignIn: "always", expectedAccount: true, keepsRecoveryMethod: true },
	[endpoint(AUTH_ROUTES.generateRecoveryCode)]: { recentSignIn: "always", expectedAccount: true },
	[endpoint(AUTH_ROUTES.recoverAccount)]: {},
};

export function authEndpointPolicy(method: string, path: string): AuthEndpointPolicy | undefined {
	return Object.hasOwn(AUTH_ENDPOINTS, `${method} ${path}`) ? AUTH_ENDPOINTS[`${method} ${path}`] : undefined;
}

export function authError(code: AuthErrorCode, status: number, message: string): Response {
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

/**
 * Applies a row of AUTH_ENDPOINTS. Returns the refusal, or null to proceed.
 * The caller supplies the session lookup, so this module needs nothing from
 * better-auth's configuration.
 */
export async function enforceAuthPolicy(
	request: Request,
	db: D1Database,
	policy: AuthEndpointPolicy,
	session: () => Promise<PolicySession | null>,
): Promise<Response | null> {
	const checksRecency = policy.recentSignIn === "always" || policy.recentSignIn === "unlessUnenrolled";
	if (policy.expectedAccount || checksRecency || policy.keepsRecoveryMethod) {
		const current = await session();
		if (!current) return authError("unauthorized", 401, "Sign in first");
		if (policy.expectedAccount && namesAnotherAccount(request.headers, current.user.id)) {
			return authError("account_mismatch", 401, "Another account signed in on this device. Reload to continue.");
		}
		if (checksRecency || policy.keepsRecoveryMethod) {
			const inventory = await credentialInventory(db, current.user.id);
			const exempt = policy.recentSignIn === "unlessUnenrolled" && isUnenrolled(inventory);
			if (checksRecency && !exempt && !isRecentSession(current.session.createdAt)) {
				return authError("recent_authentication_required", 401, "Confirm it's you with a passkey, then try again");
			}
			if (policy.keepsRecoveryMethod && isLastRecoveryMethod(inventory)) {
				return authError("last_recovery_method", 409, "Add another passkey or a recovery code before removing this one");
			}
		}
	}
	if (policy.userVerification) {
		const body = await request.clone().json().catch(() => null);
		if (!userVerified(policy.userVerification, body)) {
			return authError("user_verification_required", 400, "Your passkey must confirm it's you with a PIN, fingerprint or face");
		}
	}
	return null;
}

/** Ask authenticators for the verification the server will require. */
export async function withRequestedUserVerification(response: Response): Promise<Response> {
	if (!response.ok) return response;
	const options = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
	if (!options || typeof options !== "object") return response;
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	return Response.json({ ...options, userVerification: USER_VERIFICATION }, { status: response.status, headers });
}
