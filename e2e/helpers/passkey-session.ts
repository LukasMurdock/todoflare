import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

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
	const accountId = await page.evaluate(registerPasskey);
	await page.evaluate((id) => {
		localStorage.setItem("todoflare-account", id);
		localStorage.setItem("todoflare-welcomed", "true");
	}, accountId);
	await page.goto(`${origin}/`);
	await expect(page.getByRole("button", { name: "Add column" })).toBeVisible();
	return accountId;
}

/** Runs inside Chromium through page.evaluate. */
export async function registerPasskey() {
	const jsonHeaders = { "Content-Type": "application/json" };
	const bootstrap = await fetch("/api/auth/sign-in/anonymous", { method: "POST", headers: jsonHeaders, body: "{}" });
	if (!bootstrap.ok) {throw new Error(await bootstrap.text());}
	const provisional: unknown = await bootstrap.json();
	if (!provisional || typeof provisional !== "object" || !("user" in provisional) ||
		!provisional.user || typeof provisional.user !== "object" || !("id" in provisional.user) ||
		typeof provisional.user.id !== "string") {throw new Error("Anonymous account has no user ID");}

	const options = await fetch("/api/auth/passkey/generate-register-options?name=Primary");
	if (!options.ok) {throw new Error(await options.text());}
	// Chromium validates the JSON options and decodes their base64url fields.
	// oxlint-disable-next-line typescript/no-unsafe-argument -- The native WebAuthn JSON parser validates and decodes the server response.
	const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(await options.json());
	const credential = await navigator.credentials.create({ publicKey });
	// oxlint-disable-next-line @nkzw/no-instanceof -- Verify the browser returned a public-key credential before serializing it.
	if (!(credential instanceof PublicKeyCredential)) {throw new Error("Passkey registration returned no public key credential");}
	const verify = await fetch("/api/auth/passkey/verify-registration", {
		method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Primary", response: credential.toJSON() }),
	});
	if (!verify.ok) {throw new Error(await verify.text());}
	const provision = await fetch("/api/account", { method: "POST" });
	if (!provision.ok) {throw new Error(await provision.text());}
	return provisional.user.id;
}
