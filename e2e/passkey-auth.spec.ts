import { expect, test } from "@playwright/test";
import { addColumnAndGetId } from "./helpers/ui-session";
import { getSyncStateSnapshot, getYjsOutboxCountForColumn } from "./helpers/local-first-readers";

test("reconnects with a real passkey after expiry and preserves queued metadata and Yjs across reload", async ({ page, context, browser }) => {
	test.setTimeout(90_000);
	const origin = process.env.TODOFLARE_PASSKEY_ORIGIN ?? "http://localhost:4173";
	// Exercise real session authentication, including during app requests that
	// carry fixture headers in the isolated E2E build.
	await context.setExtraHTTPHeaders({ "X-Test-Disable-Auth-Bypass": "1" });
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
	await page.goto(origin);
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
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.mode).toBe("account_syncing");
	const columnId = await addColumnAndGetId(page);
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type("Before expiry");
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBe(0);

	await context.setOffline(true);
	await page.evaluate(() => window.dispatchEvent(new Event("offline")));
	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.type(" - queued while offline");
	await page.getByRole("button", { name: "Add column" }).click();
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.queueDepth).toBeGreaterThan(0);
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBeGreaterThan(0);

	await context.clearCookies({ name: /session_token/ });
	await context.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	const reconnect = page.getByRole("button", { name: "Reconnect with a passkey" });
	await expect(reconnect).toBeVisible();
	await page.reload();
	await expect(reconnect).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("queued while offline");
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.queueDepth).toBeGreaterThan(0);
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBeGreaterThan(0);

	// A failed WebAuthn attempt leaves the account, editors and both queues intact.
	await page.route("**/api/auth/passkey/generate-authenticate-options", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Try reconnecting again" }) }));
	await reconnect.click();
	await expect(reconnect).toBeEnabled();
	await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("queued while offline");
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.queueDepth).toBeGreaterThan(0);
	await page.unroute("**/api/auth/passkey/generate-authenticate-options");

	await reconnect.click();
	await expect(reconnect).toBeHidden();
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.queueDepth, { timeout: 20_000 }).toBe(0);
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId), { timeout: 20_000 }).toBe(0);
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.revokeDiscardCount).toBe(0);

	// A separate browser context with only the renewed cookie must receive the
	// content and column that had never reached the server before expiry.
	const observer = await browser.newContext({ storageState: { cookies: await context.cookies(), origins: [] }, extraHTTPHeaders: { "X-Test-Disable-Auth-Bypass": "1" } });
	try {
		const observerPage = await observer.newPage();
		await observerPage.addInitScript(id => {
			localStorage.setItem("todoflare-account", id);
			localStorage.setItem("todoflare-welcomed", "true");
		}, accountId);
		await observerPage.goto(origin);
		await expect(observerPage.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("queued while offline");
		await expect(observerPage.getByRole("textbox", { name: "Todo editor" })).toHaveCount(2);
	} finally { await observer.close(); }

});

interface PublicKeyCredentialCreationOptionsJSON
	extends Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> {
	challenge: string;
	user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
	excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
}
