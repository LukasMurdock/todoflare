import { expect, test } from "@playwright/test";
import { signInWithNewPasskey } from "./helpers/passkey-session";

// A change refused for want of a recent sign-in is kept, confirmed with the
// account's passkey, and retried (useRecentSignIn). Sessions here are new, so
// the server's first answer is replaced with the refusal it gives an old one.
test("confirms a refused credential change with a passkey and retries it", async ({ page, context }) => {
	const origin = process.env.TODOFLARE_PASSKEY_ORIGIN ?? "http://localhost:4173";
	const accountId = await signInWithNewPasskey(page, context, origin);
	let refusals = 0;
	await page.route("**/api/auth/recovery-code/generate", (route) => {
		if (refusals++ > 0) return route.continue();
		return route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({ error: "recent_authentication_required", code: "recent_authentication_required", message: "Confirm it's you with a passkey, then try again" }),
		});
	});

	await page.getByRole("button", { name: `${accountId.slice(0, 4)}...${accountId.slice(12)}` }).click();
	await page.getByRole("menuitem", { name: "Passkeys and recovery" }).click();
	const rotate = page.getByRole("button", { name: "Create or rotate recovery code" });
	await rotate.click();
	await expect(page.getByText("Save this now.")).toBeHidden();
	// The kept change is the one confirmed, so nothing else can change meanwhile.
	await expect(rotate).toBeDisabled();
	await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(rotate).toBeEnabled();
	refusals = 0;
	await rotate.click();

	const signIn = page.waitForResponse((response) => response.url().endsWith("/api/auth/passkey/verify-authentication") && response.status() === 200);
	await page.getByRole("button", { name: "Confirm with passkey" }).click();
	await signIn;
	await expect(page.getByText("Save this now.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Confirm with passkey" })).toBeHidden();
	expect(refusals).toBe(2);
	await expect(rotate).toBeEnabled();
});

test("drops a refused change abandoned while its confirmation is in flight", async ({ page, context }) => {
	const origin = process.env.TODOFLARE_PASSKEY_ORIGIN ?? "http://localhost:4173";
	// reauthenticate() names the account to the password manager just before
	// the hook decides whether to retry: a barrier this test can observe.
	await page.addInitScript(() => {
		(window as unknown as { confirmedSignIns: number }).confirmedSignIns = 0;
		Object.defineProperty(PublicKeyCredential, "signalCurrentUserDetails", {
			configurable: true,
			value: () => {
				(window as unknown as { confirmedSignIns: number }).confirmedSignIns++;
				return Promise.resolve();
			},
		});
	});
	const accountId = await signInWithNewPasskey(page, context, origin);
	let requests = 0;
	await page.route("**/api/auth/recovery-code/generate", (route) => {
		requests++;
		return route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({ error: "recent_authentication_required", code: "recent_authentication_required", message: "Confirm it's you with a passkey, then try again" }),
		});
	});
	// Hold the passkey sign-in so the dialog can be closed while it runs.
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => { release = resolve; });
	await page.route("**/api/auth/passkey/verify-authentication", async (route) => {
		await held;
		await route.continue();
	});

	await page.getByRole("button", { name: `${accountId.slice(0, 4)}...${accountId.slice(12)}` }).click();
	await page.getByRole("menuitem", { name: "Passkeys and recovery" }).click();
	await page.getByRole("button", { name: "Create or rotate recovery code" }).click();
	const signIn = page.waitForResponse((response) => response.url().endsWith("/api/auth/passkey/verify-authentication"));
	const signInStarted = page.waitForRequest((request) => request.url().endsWith("/api/auth/passkey/verify-authentication"));
	await page.getByRole("button", { name: "Confirm with passkey" }).click();
	await signInStarted;
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	release();
	expect((await signIn).status()).toBe(200);
	await expect.poll(() => page.evaluate(() => (window as unknown as { confirmedSignIns: number }).confirmedSignIns)).toBe(1);
	// A retry would be under way by now; let the page settle a full round trip.
	await page.getByRole("button", { name: `${accountId.slice(0, 4)}...${accountId.slice(12)}` }).click();
	await page.getByRole("menuitem", { name: "Passkeys and recovery" }).click();
	await expect(page.getByRole("button", { name: "Create or rotate recovery code" })).toBeEnabled();
	expect(requests).toBe(1);
});
