import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A WebAuthn authenticator in software (ES256, "none" attestation), so Worker
 * tests can run real registration and authentication ceremonies and choose
 * whether the authenticator reports user verification.
 */

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

type Bytes = Uint8Array<ArrayBuffer>;

const bytes = (...parts: Uint8Array[]): Bytes => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
const sha256 = async (data: Bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const utf8 = (text: string) => new TextEncoder().encode(text);
const uint32 = (value: number) => new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

/** WebCrypto signs ECDSA as raw r||s; WebAuthn carries an ASN.1 DER sequence. */
function derSignature(raw: Bytes): Bytes {
	const integer = (value: Bytes) => {
		let start = 0;
		while (start < value.length - 1 && value[start] === 0) start++;
		const trimmed = value.slice(start);
		const padded = trimmed[0] & 0x80 ? bytes(new Uint8Array([0]), trimmed) : trimmed;
		return bytes(new Uint8Array([0x02, padded.length]), padded);
	};
	const body = bytes(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return bytes(new Uint8Array([0x30, body.length]), body);
}

export interface SoftwareAuthenticator {
	credentialId: string;
	register(options: { challenge: string }, verified: boolean): Promise<unknown>;
	authenticate(options: { challenge: string }, verified: boolean): Promise<unknown>;
}

export async function softwareAuthenticator(origin: string, rpId: string): Promise<SoftwareAuthenticator> {
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
	const rawId = crypto.getRandomValues(new Uint8Array(32));
	const credentialId = isoBase64URL.fromBuffer(rawId);
	const rpIdHash = await sha256(utf8(rpId));
	let counter = 0;

	const clientData = (type: string, challenge: string) =>
		utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

	return {
		credentialId,
		async register({ challenge }, verified) {
			const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, isoBase64URL.toBuffer(jwk.x!)],
				[-3, isoBase64URL.toBuffer(jwk.y!)],
			]));
			const authData = bytes(
				rpIdHash,
				new Uint8Array([UP | AT | (verified ? UV : 0)]),
				uint32(counter),
				new Uint8Array(16),
				new Uint8Array([0, rawId.length]),
				rawId,
				publicKey,
			);
			const attestationObject = isoCBOR.encode(new Map<string, unknown>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]) as never);
			return {
				id: credentialId,
				rawId: credentialId,
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: isoBase64URL.fromBuffer(clientData("webauthn.create", challenge)),
					attestationObject: isoBase64URL.fromBuffer(attestationObject),
					transports: ["internal"],
				},
			};
		},
		async authenticate({ challenge }, verified) {
			counter++;
			const authData = bytes(rpIdHash, new Uint8Array([UP | (verified ? UV : 0)]), uint32(counter));
			const clientDataJSON = clientData("webauthn.get", challenge);
			const signature = new Uint8Array(await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				keys.privateKey,
				bytes(authData, await sha256(clientDataJSON)),
			));
			return {
				id: credentialId,
				rawId: credentialId,
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
					authenticatorData: isoBase64URL.fromBuffer(authData),
					signature: isoBase64URL.fromBuffer(derSignature(signature)),
				},
			};
		},
	};
}
