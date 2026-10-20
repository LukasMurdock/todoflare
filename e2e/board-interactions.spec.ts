import { expect, test } from "@playwright/test";
import { createAccount, createColumn } from "./helpers/account-api";
import { getSyncStateSnapshot } from "./helpers/local-first-readers";
import { bootstrapAuthenticatedPage, LOCAL_COLUMNS_KEY, WELCOME_KEY } from "./helpers/ui-session";

test("holding Cmd/Ctrl highlights links in the editor and releasing clears it", async ({ page }) => {
	await page.addInitScript(({ columnsKey, welcomeKey }) => {
		localStorage.setItem(welcomeKey, "true");
		localStorage.setItem(columnsKey, JSON.stringify([
			{ id: "00000000-0000-4000-8000-000000000001", value: [{ type: "p", children: [{ text: "Visit example.com today" }] }] },
		]));
	}, { columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	await expect(page.locator(".url-text")).toHaveText("example.com");
	await expect(page.locator(".cmd-pressed")).toHaveCount(0);
	await page.keyboard.down("ControlOrMeta");
	await expect(page.locator(".cmd-pressed .url-text")).toHaveCount(1);
	await page.keyboard.up("ControlOrMeta");
	await expect(page.locator(".cmd-pressed")).toHaveCount(0);
});

test("dialogs render inside the board, not in document.body", async ({ page }) => {
	await page.addInitScript(({ columnsKey, welcomeKey }) => {
		localStorage.setItem(welcomeKey, "true");
		localStorage.setItem(columnsKey, JSON.stringify([
			{ id: "00000000-0000-4000-8000-000000000001", value: [{ type: "p", children: [{ text: "Content" }] }] },
			{ id: "00000000-0000-4000-8000-000000000002", value: [{ type: "p", children: [{ text: "" }] }] },
		]));
	}, { columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	const board = page.locator("[data-todo-board]");

	await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
	await expect(board.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
	await page.keyboard.press("Escape");

	await board.locator("div.w-80").first().locator("div.h-10 button").last().click();
	await expect(board.getByRole("alertdialog")).toBeVisible();
	await expect(board.getByRole("alertdialog")).toContainText("This column has content. This action cannot be undone.");
});

test("signed-in columns confirm deletion only when they have content", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	await createColumn(request, appUrl, accountId);
	await createColumn(request, appUrl, accountId);
	await bootstrapAuthenticatedPage(page, accountId);

	const editors = page.getByRole("textbox", { name: "Todo editor" });
	const deleteButtons = page.getByRole("button", { name: "Delete column" });
	const confirm = page.getByRole("alertdialog", { name: "Delete column?" });
	await expect(editors).toHaveCount(3, { timeout: 15000 });

	await editors.first().click();
	await page.keyboard.type("Keep me");
	await expect(editors.first()).toContainText("Keep me");

	await deleteButtons.first().click();
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText("This column has content. You can restore it from Recently Deleted");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	await expect(editors).toHaveCount(3);

	await deleteButtons.first().click();
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(editors).toHaveCount(2);
	await expect(page.getByText("Keep me")).toHaveCount(0);

	// An empty column goes without asking.
	await deleteButtons.first().click();
	await expect(editors).toHaveCount(1);
	await expect(confirm).toHaveCount(0);
});

test("guest edits persist across reloads and can be undone", async ({ page }) => {
	await page.addInitScript(({ welcomeKey }) => localStorage.setItem(welcomeKey, "true"), { welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type("[] Guest todo");
	await expect(editor).toContainText("Guest todo");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);

	await expect
		.poll(() => page.evaluate((key) => localStorage.getItem(key) ?? "", LOCAL_COLUMNS_KEY))
		.toContain("Guest todo");
	await page.reload();
	// Saved guest data now prompts to claim it; dismiss to reach the board.
	await expect(page.getByRole("dialog", { name: "You have local data" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(editor).toContainText("Guest todo");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);

	await editor.click();
	await page.keyboard.press("End");
	await page.keyboard.type(" extra");
	await expect(editor).toContainText("Guest todo extra");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(editor).not.toContainText("extra");
	await expect(editor).toContainText("Guest todo");
});

test("Mod+/ opens shortcuts once from inside the editor and from the page", async ({ page }) => {
	await page.addInitScript(({ welcomeKey }) => localStorage.setItem(welcomeKey, "true"), { welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });

	// Inside the board: handled by the board only (handled twice would open and close it).
	await page.getByRole("textbox", { name: "Todo editor" }).first().click();
	await page.keyboard.press("ControlOrMeta+/");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("ControlOrMeta+/");
	await expect(dialog).toBeHidden();

	// Focus outside the board: the app's page-wide shortcut opens it.
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press("ControlOrMeta+/");
	await expect(dialog).toBeVisible();
});

test("a rejected change is still in the sync debug snapshot after a reload", async ({ page, context, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	const columnId = await createColumn(request, appUrl, accountId);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route(`**/api/column/${columnId}`, (route) =>
		route.request().method() === "DELETE"
			? route.fulfill({ status: 404, json: { error: "Column not found", code: "not_found", message: "Column not found" } })
			: route.fallback(),
	);
	await bootstrapAuthenticatedPage(page, accountId);

	const editors = page.getByRole("textbox", { name: "Todo editor" });
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await page.getByRole("button", { name: "Delete column" }).last().click();
	await expect(page.getByText("Some offline changes could not be synced")).toBeVisible({ timeout: 15000 });
	// The toast shows before IndexedDB commits the record; reload only once it has.
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.recentSyncFailureCount, { timeout: 15000 }).toBe(1);
	await page.reload();
	await expect(editors).toHaveCount(2, { timeout: 15000 });

	const compactAccountId = accountId.replace(/\D/g, "");
	const readSnapshot = async () => {
		await page.getByRole("button", { name: `${compactAccountId.slice(0, 4)}...${compactAccountId.slice(-4)}` }).click();
		await page.getByRole("menuitem", { name: /Copy Sync Debug Snapshot/ }).click();
		await page.keyboard.press("Escape");
		return JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
			recentSyncFailures: unknown[];
		};
	};
	await expect.poll(async () => (await readSnapshot()).recentSyncFailures, { timeout: 15000 }).toEqual([
		expect.objectContaining({ opType: "column.delete", reason: "not_found", status: 404, code: "not_found" }),
	]);
});

test("a rejected change says what the server answered", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	const columnId = await createColumn(request, appUrl, accountId);
	await page.route(`**/api/column/${columnId}`, (route) =>
		route.request().method() === "DELETE"
			? route.fulfill({ status: 404, json: { error: "Column not found", code: "not_found", message: "Column not found" } })
			: route.fallback(),
	);
	await bootstrapAuthenticatedPage(page, accountId);

	const editors = page.getByRole("textbox", { name: "Todo editor" });
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await page.getByRole("button", { name: "Delete column" }).last().click();

	await expect(page.getByText("Some offline changes could not be synced")).toBeVisible({ timeout: 15000 });
	await expect(page.getByText("column.delete: Column not found (404 not_found)")).toBeVisible();
});

test("an unknown outcome stops retrying and resyncs from the server", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	const columnId = await createColumn(request, appUrl, accountId);
	let deleteAttempts = 0;
	// The server answers as it does for a claim whose request died before recording a result.
	await page.route(`**/api/column/${columnId}`, (route) => {
		if (route.request().method() !== "DELETE") return route.fallback();
		deleteAttempts += 1;
		return route.fulfill({
			status: 409,
			json: {
				error: "idempotency_outcome_unknown",
				code: "idempotency_outcome_unknown",
				message: "A previous attempt may have executed, but its outcome could not be recorded.",
			},
		});
	});
	await bootstrapAuthenticatedPage(page, accountId);

	const editors = page.getByRole("textbox", { name: "Todo editor" });
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await page.getByRole("button", { name: "Delete column" }).last().click();

	await expect(page.getByText("column.delete: A previous attempt may have executed")).toBeVisible({ timeout: 15000 });
	// Fresh server state wins: the column was never deleted there, so it is back, and nothing is left queued.
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await page.waitForTimeout(3000);
	expect(deleteAttempts).toBe(1);
});

test("the sync debug snapshot lists changes the server keeps retrying", async ({ page, context, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	const columnId = await createColumn(request, appUrl, accountId);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route(`**/api/column/${columnId}`, (route) =>
		route.request().method() === "DELETE"
			? route.fulfill({ status: 503, json: { error: "Column storage is busy", code: "durable_object_unavailable", message: "Column storage is busy" } })
			: route.fallback(),
	);
	await bootstrapAuthenticatedPage(page, accountId);

	const editors = page.getByRole("textbox", { name: "Todo editor" });
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await page.getByRole("button", { name: "Delete column" }).last().click();

	const compactAccountId = accountId.replace(/\D/g, "");
	const readSnapshot = async () => {
		await page.getByRole("button", { name: `${compactAccountId.slice(0, 4)}...${compactAccountId.slice(-4)}` }).click();
		await page.getByRole("menuitem", { name: /Copy Sync Debug Snapshot/ }).click();
		await page.keyboard.press("Escape");
		return JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
			pendingCommands: Array<{ opType: string; attemptCount: number; lastError: string | null }>;
		};
	};
	await expect.poll(async () => (await readSnapshot()).pendingCommands, { timeout: 15000 }).toEqual([
		expect.objectContaining({ opType: "column.delete", lastError: "Column storage is busy" }),
	]);
});
