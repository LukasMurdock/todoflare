import {
	decodeAttestationObject,
	isoBase64URL,
	parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";

/** How recently an account must have signed in to change its credentials. */
export const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;

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
 * A passkey is an account's only credential, so a ceremony must prove both
 * possession and user verification (PIN or biometric). Better Auth's plugin
 * verifies signatures but hard-codes `requireUserVerification: false`; this
 * reads the UV flag from the same authenticator data it verifies.
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

/** Session age, not activity: rolling refresh never makes a session recent. */
export function isRecentSession(createdAt: Date | string | number, now = Date.now()): boolean {
	return now - new Date(createdAt).getTime() <= RECENT_AUTHENTICATION_MS;
}
