import { expect, test } from "@playwright/test";
import { signInWithNewPasskey } from "./helpers/passkey-session";

declare global {
	interface Window {
		passkeySignals: { name: string; options: unknown }[];
	}
}

// Also drives the credential manager's recovery-code and session calls through
// the real auth client, which Worker tests cannot reach.
test("tells the password manager when a passkey is deleted", async ({ page, context }) => {
	const origin = process.env.TODOFLARE_PASSKEY_ORIGIN ?? "http://localhost:4173";
	// Record each Signal API call, then pass it on to Chromium's own.
	await page.addInitScript(() => {
		window.passkeySignals = [];
		for (const name of ["signalUnknownCredential", "signalAllAcceptedCredentials", "signalCurrentUserDetails"] as const) {
			const real = name in PublicKeyCredential ? PublicKeyCredential[name].bind(PublicKeyCredential) : null;
			Object.defineProperty(PublicKeyCredential, name, {
				configurable: true,
				value: (options: never) => {
					window.passkeySignals.push({ name, options });
					return real ? real(options).catch(() => undefined) : Promise.resolve();
				},
			});
		}
	});
	const accountId = await signInWithNewPasskey(page, context, origin);
	const [{ credentialID }] = await page.evaluate(async () =>
		(await fetch("/api/auth/passkey/list-user-passkeys")).json() as Promise<{ credentialID: string }[]>,
	);

	await page.getByRole("button", { name: `${accountId.slice(0, 4)}...${accountId.slice(12)}` }).click();
	await page.getByRole("menuitem", { name: "Passkeys and recovery" }).click();
	// The only passkey can go once a recovery code exists.
	await page.getByRole("button", { name: "Create or rotate recovery code" }).click();
	await expect(page.getByText("Save this now.")).toBeVisible();
	await page.getByRole("button", { name: "Remove" }).click();
	await expect(page.getByText("Passkey removed.")).toBeVisible();

	const signals = await page.evaluate(() => window.passkeySignals);
	expect(signals).toContainEqual({
		name: "signalUnknownCredential",
		options: { rpId: new URL(origin).hostname, credentialId: credentialID },
	});
	// A list is never complete enough to tell a manager which passkeys to keep.
	expect(signals.map((signal) => signal.name)).not.toContain("signalAllAcceptedCredentials");

	await page.getByRole("button", { name: "Sign out other sessions" }).click();
	await expect(page.getByText("Other sessions are signed out.")).toBeVisible();
});
