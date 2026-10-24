import { displayAccountId, normalizeAccountId } from "./account";

/**
 * How a passkey names its account to browsers and password managers
 * ([0018](../../docs/decisions/0018-passkeys-name-their-account.md)).
 *
 * The server writes this into registration options; the client repeats it
 * through the WebAuthn Signal API. The user handle (`id`) is the same for
 * every passkey of an account, so one signal reaches all of them. It encodes
 * the Account ID. WebAuthn asks for handles that identify nobody, because an
 * authenticator may reveal a handle before user verification; here that
 * links the passkey to a public Account ID, which a stolen authenticator's
 * holder could also read from the passkey's name. 0018 records the tradeoff.
 */
export function passkeyUser(accountId: string): { id: string; name: string; displayName: string } {
	const id = normalizeAccountId(accountId);
	const name = displayAccountId(id);
	return {
		id: btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
		name,
		displayName: name,
	};
}
