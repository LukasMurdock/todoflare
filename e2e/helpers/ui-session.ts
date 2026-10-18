import { expect, type Page } from "@playwright/test";
import { LOCAL_COLUMNS_STORAGE_KEY } from "../../src/lib/local-column-storage";

export const ACCOUNT_STORAGE_KEY = "todoflare-account";
export const WELCOME_KEY = "todoflare-welcomed";
export const LOCAL_COLUMNS_KEY = LOCAL_COLUMNS_STORAGE_KEY;

export async function bootstrapAuthenticatedPage(
	page: Page,
	accountId: string,
): Promise<void> {
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

export async function ensureColumnExists(page: Page): Promise<void> {
	const collapseButtons = page.getByRole("button", { name: "Collapse column" });
	if ((await collapseButtons.count()) > 0) return;

	// Exactly the create route: the new column's ws-ticket POST also contains "/api/column".
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

	await expect(collapseButtons.first()).toBeVisible({ timeout: 15000 });
}

export async function addColumnAndGetId(page: Page): Promise<string> {
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
	await expect(
		page.getByRole("button", { name: "Collapse column" }).first(),
	).toBeVisible({ timeout: 15000 });

	return payload.column.id;
}
