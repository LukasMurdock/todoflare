import { expect, test } from "@playwright/test";

test("registers and signs back in with a discoverable passkey", async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});

	// This scenario exercises sign-in from the existing guest-data dialog.
	// Seed actual content so empty-editor normalization does not decide which
	// dialog opens or start a competing conditional WebAuthn request.
	await page.addInitScript(() => {
		if (!localStorage.getItem("todoflare-columns")) localStorage.setItem("todoflare-columns", JSON.stringify([
			{ id: "passkey-guest", value: [{ type: "p", children: [{ text: "Guest draft" }] }] },
		]));
	});
	await page.goto("http://localhost:4173/");
	const accountId = await page.evaluate(async () => {
		const encode = (value: ArrayBuffer): string => {
			const bytes = new Uint8Array(value);
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		};
		const decode = (value: string): ArrayBuffer => {
			const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
			const binary = atob(padded);
			return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
		};

		const bootstrap = await fetch("/api/auth/sign-in/anonymous", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
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
				excludeCredentials: options.excludeCredentials?.map((item) => ({
					...item,
					id: decode(item.id),
				})),
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
		await fetch("/api/auth/sign-out", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		return provisional.user.id;
	});

	await page.reload();
	await expect(page.getByRole("heading", { name: "You have local data" })).toBeVisible();
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expect(page.getByText(accountId.slice(0, 4), { exact: false }).first()).toBeVisible();
});

interface PublicKeyCredentialCreationOptionsJSON
	extends Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> {
	challenge: string;
	user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
	excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
}
