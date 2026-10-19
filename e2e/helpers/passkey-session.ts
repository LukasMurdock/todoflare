import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Signs a fresh account in with a real passkey on a virtual authenticator, as
 * on a deployed origin where the E2E header bypass does not exist. Leaves the
 * page on the board, signed in, and returns the account ID.
 */
export async function signInWithNewPasskey(page: Page, context: BrowserContext): Promise<string> {
	await context.setExtraHTTPHeaders({ "X-Test-Disable-Auth-Bypass": "1" });
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
	});
	await page.goto("/");
	const accountId = await page.evaluate(async () => {
		const encode = (value: ArrayBuffer): string => {
			let binary = "";
			for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
			return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		};
		const decode = (value: string): ArrayBuffer => {
			const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
			return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
		};
		const bootstrap = await fetch("/api/auth/sign-in/anonymous", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		if (!bootstrap.ok) throw new Error(await bootstrap.text());
		const provisional = (await bootstrap.json()) as { user: { id: string } };
		const optionsResponse = await fetch("/api/auth/passkey/generate-register-options?name=Primary");
		if (!optionsResponse.ok) throw new Error(await optionsResponse.text());
		const options = (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
		const credential = (await navigator.credentials.create({
			publicKey: {
				...options,
				challenge: decode(options.challenge),
				user: { ...options.user, id: decode(options.user.id) },
				excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
			},
		})) as PublicKeyCredential;
		const attestation = credential.response as AuthenticatorAttestationResponse;
		const verification = await fetch("/api/auth/passkey/verify-registration", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Primary",
				response: {
					id: credential.id,
					rawId: encode(credential.rawId),
					type: credential.type,
					authenticatorAttachment: credential.authenticatorAttachment,
					response: {
						clientDataJSON: encode(attestation.clientDataJSON),
						attestationObject: encode(attestation.attestationObject),
						transports: attestation.getTransports?.() ?? [],
					},
					clientExtensionResults: credential.getClientExtensionResults(),
				},
			}),
		});
		if (!verification.ok) throw new Error(await verification.text());
		const provision = await fetch("/api/account", { method: "POST" });
		if (!provision.ok) throw new Error(await provision.text());
		localStorage.setItem("todoflare-account", provisional.user.id);
		localStorage.setItem("todoflare-welcomed", "true");
		return provisional.user.id;
	});
	await page.reload();
	await expect(page.getByRole("button", { name: "Add column" })).toBeVisible();
	return accountId;
}
