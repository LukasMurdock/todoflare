import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const ACCOUNT_STORAGE_KEY = "todoflare-account";
const WELCOME_KEY = "todoflare-welcomed";
const LOCAL_COLUMNS_KEY = "todoflare-columns";

async function createAccount(request: APIRequestContext, baseURL: string) {
	const syntheticIp = `10.0.0.${Math.floor(Math.random() * 200) + 10}`;
	const response = await request.post(`${baseURL}/api/account`, {
		headers: {
			"X-Forwarded-For": syntheticIp,
		},
	});

	if (!response.ok()) {
		throw new Error(
			`Failed to create account (${response.status()}): ${await response.text()}`,
		);
	}

	const data = (await response.json()) as {
		account: { id: string };
	};

	return data.account.id;
}

async function bootstrapAuthenticatedPage(page: Page, accountId: string) {
	await page.addInitScript(
		({ accountStorageKey, localColumnsKey, welcomeKey, id }) => {
			window.localStorage.setItem(accountStorageKey, id);
			window.localStorage.setItem(welcomeKey, "true");
			window.localStorage.removeItem(localColumnsKey);
		},
		{
			accountStorageKey: ACCOUNT_STORAGE_KEY,
			localColumnsKey: LOCAL_COLUMNS_KEY,
			welcomeKey: WELCOME_KEY,
			id: accountId,
		},
	);

	await page.goto("/");
	await expect(page.getByRole("button", { name: "Add column" })).toBeVisible();
}

async function ensureColumnExists(page: Page) {
	const collapseButtons = page.getByRole("button", { name: "Collapse column" });
	if ((await collapseButtons.count()) > 0) return;

	const createResponsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().includes("/api/column"),
	);
	await page.getByRole("button", { name: "Add column" }).click();
	const createResponse = await createResponsePromise;
	if (!createResponse.ok()) {
		throw new Error(`Failed to create column: ${await createResponse.text()}`);
	}

	await expect(collapseButtons.first()).toBeVisible({ timeout: 15000 });
}

async function addColumnAndGetId(page: Page) {
	const createResponsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/column"),
	);
	await page.getByRole("button", { name: "Add column" }).click();
	const createResponse = await createResponsePromise;
	if (!createResponse.ok()) {
		throw new Error(`Failed to create column: ${await createResponse.text()}`);
	}
	const payload = (await createResponse.json()) as { column: { id: string } };
	await expect(page.getByRole("button", { name: "Collapse column" }).first()).toBeVisible({ timeout: 15000 });
	return payload.column.id;
}

test.describe("collaborative editing", () => {
	test("generate account and claim data keeps local offline data", async ({ page }) => {
		await page.addInitScript(({ localColumnsKey, welcomeKey }) => {
			const offlineColumns = [
				{
					id: "local-col-1",
					value: [
						{ type: "p", children: [{ text: "offline claim text" }] },
					],
					collapsed: false,
				},
			];

			window.localStorage.removeItem("todoflare-account");
			window.localStorage.setItem(welcomeKey, "true");
			window.localStorage.setItem(localColumnsKey, JSON.stringify(offlineColumns));
		}, {
			localColumnsKey: LOCAL_COLUMNS_KEY,
			welcomeKey: WELCOME_KEY,
		});

		await page.goto("/");
		await expect(
			page.getByRole("heading", { name: "You have existing local data" }),
		).toBeVisible();

		await page.getByRole("button", { name: "Generate Account & Claim Data" }).click();

		await expect(
			page.getByRole("heading", { name: "You have existing local data" }),
		).toHaveCount(0);

		const localData = await page.evaluate((localColumnsKey) => {
			return window.localStorage.getItem(localColumnsKey);
		}, LOCAL_COLUMNS_KEY);

		expect(localData).toContain("offline claim text");
	});

	test("stale stored account id falls back to account modal", async ({ page }) => {
		const staleAccountId = `9999 0000 ${Math.floor(Date.now() % 10000)
			.toString()
			.padStart(4, "0")} 1234`;

		await page.addInitScript(
			({ accountStorageKey, localColumnsKey, welcomeKey, id }) => {
				window.localStorage.setItem(accountStorageKey, id);
				window.localStorage.setItem(welcomeKey, "true");
				window.localStorage.removeItem(localColumnsKey);
			},
			{
				accountStorageKey: ACCOUNT_STORAGE_KEY,
				localColumnsKey: LOCAL_COLUMNS_KEY,
				welcomeKey: WELCOME_KEY,
				id: staleAccountId,
			},
		);

		await page.goto("/");

		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("heading", { name: "Welcome to Todoflare" }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Generate New Account" })).toBeVisible();
	});

	test("syncs edits between two tabs of the same account", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);

		const firstContext = await browser.newContext();
		const firstPage = await firstContext.newPage();
		await bootstrapAuthenticatedPage(firstPage, accountId);
		await addColumnAndGetId(firstPage);

		const secondContext = await browser.newContext();
		const secondPage = await secondContext.newPage();
		await bootstrapAuthenticatedPage(secondPage, accountId);

		const text = `Cross-tab ${Date.now()}`;
		const firstEditor = firstPage.getByRole("textbox", { name: "Todo editor" }).first();
		await firstEditor.click();
		await firstPage.keyboard.type(text);

		const secondEditor = secondPage.getByRole("textbox", { name: "Todo editor" }).first();
		await expect.poll(async () => (await secondEditor.innerText()).trim()).toContain(
			text,
		);

		await firstContext.close();
		await secondContext.close();
	});

	test("collapses and re-expands a column", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, accountId);
		await addColumnAndGetId(page);

		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1);
		await page.getByRole("button", { name: "Collapse column" }).click();
		await expect(page.getByRole("button", { name: "Expand column" })).toHaveCount(1);

		await page.getByRole("button", { name: "Expand column" }).click();
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1);
	});

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

	test("owner can enable a public link and public API is reachable", async ({
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
});
