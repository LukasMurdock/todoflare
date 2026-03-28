import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import {
	addColumnAndGetId,
	bootstrapAuthenticatedPage,
} from "./helpers/ui-session";
import {
	getSyncStateSnapshot,
	getYjsOutboxCountForColumn,
} from "./helpers/local-first-readers";

test.describe("collaborative editing", () => {
	test("owner can share a column and collaborator can see it", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";

		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		const ownerContext = await browser.newContext();
		const ownerPage = await ownerContext.newPage();
		await bootstrapAuthenticatedPage(ownerPage, ownerId);
		await addColumnAndGetId(ownerPage);

		await ownerPage.getByRole("button", { name: "Share column" }).first().click();
		await ownerPage.getByRole("textbox", { name: "Account ID" }).fill(collaboratorId);
		const shareResponsePromise = ownerPage.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share"),
		);
		await ownerPage.getByRole("button", { name: "Share", exact: true }).click();
		const shareResponse = await shareResponsePromise;
		expect(shareResponse.ok()).toBeTruthy();

		const collaboratorContext = await browser.newContext();
		const collaboratorPage = await collaboratorContext.newPage();
		await bootstrapAuthenticatedPage(collaboratorPage, collaboratorId);

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;

		await expect(
			collaboratorPage.getByText(`Shared by ${ownerShort}`),
		).toBeVisible();
		await expect(
			collaboratorPage.getByRole("button", { name: "Share column" }),
		).toHaveCount(0);

		await ownerContext.close();
		await collaboratorContext.close();
	});

	test("owner can enable public link and public page shows read-only content", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";

		const ownerId = await createAccount(request, appUrl);
		const ownerContext = await browser.newContext();
		const ownerPage = await ownerContext.newPage();

		await bootstrapAuthenticatedPage(ownerPage, ownerId);
		await addColumnAndGetId(ownerPage);

		const publicText = `Public text ${Date.now()}`;
		const ownerEditor = ownerPage
			.getByRole("textbox", { name: "Todo editor" })
			.first();
		await ownerEditor.click();
		await ownerPage.keyboard.type(publicText);

		await ownerPage.getByRole("button", { name: "Share column" }).first().click();
		const publicLinkResponsePromise = ownerPage.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().endsWith("/public"),
		);
		await ownerPage.getByRole("button", { name: "Enable public link" }).click();
		const publicLinkResponse = await publicLinkResponsePromise;
		expect(publicLinkResponse.ok()).toBeTruthy();

		const publicLinkPayload = (await publicLinkResponse.json()) as {
			url: string;
		};
		const publicUrl = publicLinkPayload.url;
		const publicIdMatch = publicUrl.match(/\/p\/([a-zA-Z0-9]+)$/);
		expect(publicIdMatch).not.toBeNull();
		const publicId = publicIdMatch?.[1] ?? "";

		const publicApiResponse = await request.get(`${appUrl}/api/p/${publicId}`);
		expect(publicApiResponse.ok()).toBeTruthy();

		await ownerPage.goto(publicUrl);
		if ((await ownerPage.getByText("404 Not Found").count()) > 0) {
			test.skip(
				true,
				"Preview server does not route /p/* through worker runtime; API route is still verified.",
			);
		}

		await expect(ownerPage.getByText("Public View")).toBeVisible();
		await expect(ownerPage.getByText(publicText)).toBeVisible();
		await expect(ownerPage.getByRole("link", { name: "Create your own" })).toBeVisible();
		await expect(ownerPage.getByRole("button", { name: "Add column" })).toHaveCount(0);
		await expect(ownerPage.getByRole("button", { name: "Share column" })).toHaveCount(0);

		await ownerContext.close();
	});

	test("owner can revoke collaborator access", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";

		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		const ownerContext = await browser.newContext();
		const ownerPage = await ownerContext.newPage();
		await bootstrapAuthenticatedPage(ownerPage, ownerId);
		const columnId = await addColumnAndGetId(ownerPage);

		await ownerPage.getByRole("button", { name: "Share column" }).first().click();
		await ownerPage.getByRole("textbox", { name: "Account ID" }).fill(collaboratorId);
		const shareResponsePromise = ownerPage.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share"),
		);
		await ownerPage.getByRole("button", { name: "Share", exact: true }).click();
		const shareResponse = await shareResponsePromise;
		expect(shareResponse.ok()).toBeTruthy();

		const collaboratorContext = await browser.newContext();
		const collaboratorPage = await collaboratorContext.newPage();
		await bootstrapAuthenticatedPage(collaboratorPage, collaboratorId);

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;
		await expect(
			collaboratorPage.getByText(`Shared by ${ownerShort}`),
		).toBeVisible({ timeout: 15000 });

		const revokeResponse = await request.delete(
			`${appUrl}/api/column/${columnId}/share/${collaboratorId.replace(/\s/g, "")}`,
			{
				headers: {
					"X-Account-ID": ownerId,
				},
			},
		);
		expect(revokeResponse.ok()).toBeTruthy();

		await collaboratorPage.reload();
		await expect(
			collaboratorPage.getByText(`Shared by ${ownerShort}`),
		).toHaveCount(0);

		await ownerContext.close();
		await collaboratorContext.close();
	});

	test("revoked collaborator offline edits are discarded on reconnect", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";

		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		const ownerContext = await browser.newContext();
		const ownerPage = await ownerContext.newPage();
		await bootstrapAuthenticatedPage(ownerPage, ownerId);
		const columnId = await addColumnAndGetId(ownerPage);

		await ownerPage.getByRole("button", { name: "Share column" }).first().click();
		await ownerPage.getByRole("textbox", { name: "Account ID" }).fill(collaboratorId);
		const shareResponsePromise = ownerPage.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share"),
		);
		await ownerPage.getByRole("button", { name: "Share", exact: true }).click();
		const shareResponse = await shareResponsePromise;
		expect(shareResponse.ok()).toBeTruthy();

		const collaboratorContext = await browser.newContext();
		const collaboratorPage = await collaboratorContext.newPage();
		await bootstrapAuthenticatedPage(collaboratorPage, collaboratorId);

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;
		await expect(
			collaboratorPage.getByText(`Shared by ${ownerShort}`),
		).toBeVisible({ timeout: 15000 });

		const collaboratorEditor = collaboratorPage
			.getByRole("textbox", { name: "Todo editor" })
			.first();

		await collaboratorContext.setOffline(true);
		await collaboratorPage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await collaboratorPage.evaluate(() => {
			const win = window as Window & {
				__todoflareOriginalWsSend?: typeof WebSocket.prototype.send;
				__todoflarePatchedWsSend?: boolean;
			};
			if (win.__todoflarePatchedWsSend) return;
			win.__todoflareOriginalWsSend = WebSocket.prototype.send;
			WebSocket.prototype.send = function () {
				throw new Error("forced-offline-send");
			};
			win.__todoflarePatchedWsSend = true;
		});

		await collaboratorEditor.click();
		await collaboratorPage.keyboard.type(`revoked offline edit ${Date.now()}`);

		await expect
			.poll(
				() =>
					getYjsOutboxCountForColumn(
						collaboratorPage,
						collaboratorId,
						columnId,
					),
				{
					timeout: 10000,
				},
			)
			.toBeGreaterThan(0);

		const revokeResponse = await request.delete(
			`${appUrl}/api/column/${columnId}/share/${collaboratorId.replace(/\s/g, "")}`,
			{
				headers: {
					"X-Account-ID": ownerId,
				},
			},
		);
		expect(revokeResponse.ok()).toBeTruthy();

		await collaboratorPage.evaluate(() => {
			const win = window as Window & {
				__todoflareOriginalWsSend?: typeof WebSocket.prototype.send;
				__todoflarePatchedWsSend?: boolean;
			};
			if (win.__todoflareOriginalWsSend) {
				WebSocket.prototype.send = win.__todoflareOriginalWsSend;
			}
			win.__todoflarePatchedWsSend = false;
		});

		await collaboratorContext.setOffline(false);
		await collaboratorPage.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		await expect
			.poll(
				() =>
					getYjsOutboxCountForColumn(
						collaboratorPage,
						collaboratorId,
						columnId,
					),
				{
					timeout: 20000,
				},
			)
			.toBe(0);

		await expect
			.poll(
				async () =>
					(await getSyncStateSnapshot(collaboratorPage, collaboratorId))
						?.revokeDiscardCount ?? 0,
				{
					timeout: 20000,
				},
			)
			.toBeGreaterThan(0);

		const collaboratorCompactId = collaboratorId.replace(/\s/g, "");
		const collaboratorShort = `${collaboratorCompactId.slice(0, 4)}...${collaboratorCompactId.slice(-4)}`;

		await collaboratorPage.getByRole("button", { name: collaboratorShort }).click();
		const resetSyncTelemetryItem = collaboratorPage.getByRole("menuitem", {
			name: "Reset Sync Telemetry",
		});
		await expect(resetSyncTelemetryItem).toBeEnabled();
		await resetSyncTelemetryItem.click();

		await expect
			.poll(
				async () => {
					const snapshot = await getSyncStateSnapshot(collaboratorPage, collaboratorId);
					if (!snapshot) return null;

					return {
						lastReplayLatencyMs: snapshot.lastReplayLatencyMs,
						revokeDiscardCount: snapshot.revokeDiscardCount,
						convergenceFailureCount: snapshot.convergenceFailureCount,
					};
				},
				{
					timeout: 10000,
				},
			)
			.toEqual({
				lastReplayLatencyMs: null,
				revokeDiscardCount: 0,
				convergenceFailureCount: 0,
			});

		await collaboratorPage.getByRole("button", { name: collaboratorShort }).click();
		await expect(
			collaboratorPage.getByRole("menuitem", {
				name: "Reset Sync Telemetry",
			}),
		).toBeDisabled();

		await expect(
			collaboratorPage.getByText(`Shared by ${ownerShort}`),
		).toHaveCount(0);

		await ownerContext.close();
		await collaboratorContext.close();
	});

	test("share list shows account and removes it after revoke", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, ownerId);
		await addColumnAndGetId(page);

		await page.getByRole("button", { name: "Share column" }).first().click();
		const collaboratorDigits = collaboratorId.replace(/\s/g, "");
		await page.getByRole("textbox", { name: "Account ID" }).click();
		await page.getByRole("textbox", { name: "Account ID" }).fill(collaboratorDigits);
		await expect(page.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
		const shareResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share"),
		);
		await page.getByRole("button", { name: "Share", exact: true }).click();
		const shareResponse = await shareResponsePromise;
		expect(shareResponse.ok()).toBeTruthy();

		const compactId = collaboratorId.replace(/\s/g, "");
		const shortId = `${compactId.slice(0, 4)}...${compactId.slice(-4)}`;

		await expect(page.getByText(shortId)).toBeVisible();

		await page.getByRole("button", { name: `Revoke access for ${shortId}` }).click();
		await expect(page.getByText(shortId)).toHaveCount(0);
	});

	test("replays queued share and revoke after reconnect", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, ownerId);
		await addColumnAndGetId(page);

		await page.getByRole("button", { name: "Share column" }).first().click();
		const collaboratorDigits = collaboratorId.replace(/\s/g, "");
		await page.getByRole("textbox", { name: "Account ID" }).fill(collaboratorDigits);
		await expect(page.getByRole("button", { name: "Share", exact: true })).toBeEnabled();

		const compactId = collaboratorId.replace(/\s/g, "");
		const shortId = `${compactId.slice(0, 4)}...${compactId.slice(-4)}`;

		await page.context().setOffline(true);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await page.getByRole("button", { name: "Share", exact: true }).click();
		await expect(page.getByText("Failed to share. Check the account ID.")).toBeVisible();

		const replayShareResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share"),
		);

		await page.context().setOffline(false);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		const replayShareResponse = await replayShareResponsePromise;
		expect(replayShareResponse.ok()).toBeTruthy();
		await expect(page.getByText(shortId)).toBeVisible();

		await page.context().setOffline(true);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await page.getByRole("button", { name: `Revoke access for ${shortId}` }).click();
		await expect(page.getByText(shortId)).toBeVisible();

		const replayRevokeResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "DELETE" &&
				response.url().includes("/api/column/") &&
				response.url().includes("/share/"),
		);

		await page.context().setOffline(false);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		const replayRevokeResponse = await replayRevokeResponsePromise;
		expect(replayRevokeResponse.ok()).toBeTruthy();
		await expect(page.getByText(shortId)).toHaveCount(0);
	});

	test("replays queued public link enable and disable after reconnect", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, ownerId);
		await addColumnAndGetId(page);

		await page.getByRole("button", { name: "Share column" }).first().click();

		await page.context().setOffline(true);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await page.getByRole("button", { name: "Enable public link" }).click();
		await expect(page.getByRole("button", { name: "Enable public link" })).toBeVisible();

		const replayEnableResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/api/column/") &&
				response.url().endsWith("/public"),
		);

		await page.context().setOffline(false);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		const replayEnableResponse = await replayEnableResponsePromise;
		expect(replayEnableResponse.ok()).toBeTruthy();
		await expect(page.getByRole("button", { name: "Disable" })).toBeVisible();

		await page.context().setOffline(true);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await page.getByRole("button", { name: "Disable" }).click();
		await expect(page.getByRole("button", { name: "Disable" })).toBeVisible();

		const replayDisableResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "DELETE" &&
				response.url().includes("/api/column/") &&
				response.url().endsWith("/public"),
		);

		await page.context().setOffline(false);
		await page.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		const replayDisableResponse = await replayDisableResponsePromise;
		expect(replayDisableResponse.ok()).toBeTruthy();
		await expect(page.getByRole("button", { name: "Enable public link" })).toBeVisible();
	});
});
