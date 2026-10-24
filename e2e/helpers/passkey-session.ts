import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Signs a fresh account in with a real passkey on a virtual authenticator, as
 * on a deployed origin where the E2E header bypass does not exist. Leaves the
 * page on the board, signed in, and returns the account ID. Locally, pass a
 * `localhost` origin: WebAuthn refuses an IP address as the RP ID.
 */
export async function signInWithNewPasskey(page: Page, context: BrowserContext, origin = ""): Promise<string> {
	await context.setExtraHTTPHeaders({ "X-Test-Disable-Auth-Bypass": "1" });
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
	});
	// Register on a same-origin page that does not run the app. On a fresh
	// visit the app opens its sign-in dialog, which starts a conditional
	// WebAuthn request, and Chromium refuses create() for the first moments of
	// one ("A request is already pending").
	await page.goto(`${origin}/robots.txt`);
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
		if (!bootstrap.ok) throw new Error(`sign-in/anonymous ${bootstrap.status}: ${await bootstrap.text()}`);
		const provisional = (await bootstrap.json()) as { user: { id: string } };
		const optionsResponse = await fetch("/api/auth/passkey/generate-register-options?name=Primary");
		if (!optionsResponse.ok) throw new Error(`generate-register-options ${optionsResponse.status}: ${await optionsResponse.text()}`);
		const options = (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
		const credential = (await navigator.credentials.create({
			publicKey: {
				...options,
				challenge: decode(options.challenge),
				user: { ...options.user, id: decode(options.user.id) },
				excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
			},
		}).catch((cause: unknown) => {
			throw new Error(`navigator.credentials.create: ${String(cause)}`);
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
		if (!verification.ok) throw new Error(`verify-registration ${verification.status}: ${await verification.text()}`);
		const provision = await fetch("/api/account", { method: "POST" });
		if (!provision.ok) throw new Error(`POST /api/account ${provision.status}: ${await provision.text()}`);
		localStorage.setItem("todoflare-account", provisional.user.id);
		localStorage.setItem("todoflare-welcomed", "true");
		return provisional.user.id;
	});
	await page.goto(`${origin}/`);
	await expect(page.getByRole("button", { name: "Add column" })).toBeVisible();
	return accountId;
}
