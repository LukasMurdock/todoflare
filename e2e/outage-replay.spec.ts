import { expect, test } from "@playwright/test";
import {
	createAccount,
	createColumn,
	getAccountColumnOrder,
} from "./helpers/account-api";
import {
	withTemporaryBackendOutage,
	waitForQueueToDrain,
	waitForQueuedMutations,
} from "./helpers/sync-outage";
import { getSyncStateSnapshot } from "./helpers/local-first-readers";
import {
	addColumnAndGetId,
	bootstrapAuthenticatedPage,
} from "./helpers/ui-session";

test.describe("collaborative editing", () => {
	test("replays queued share after temporary backend outage", async ({
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

		const collaboratorContext = await browser.newContext();
		const collaboratorPage = await collaboratorContext.newPage();
		await bootstrapAuthenticatedPage(collaboratorPage, collaboratorId);

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;

		await withTemporaryBackendOutage(
			ownerPage,
			"**/api/column/**/share",
			async () => {
				await ownerPage.getByRole("button", { name: "Share column" }).first().click();
				await ownerPage.getByRole("textbox", { name: "Account ID" }).fill(collaboratorId);
				await expect(ownerPage.getByRole("button", { name: "Share", exact: true })).toBeEnabled();

				await ownerPage.getByRole("button", { name: "Share", exact: true }).click();
				await waitForQueuedMutations(ownerPage, ownerId);

				await expect(
					collaboratorPage.getByText(`Shared by ${ownerShort}`),
				).toHaveCount(0);
			},
		);

		// Keep one smoke test on the production five-second cadence. The rest of
		// this matrix uses the deterministic E2E wake trigger.
		await waitForQueueToDrain(ownerPage, ownerId, {
			timeout: 15000,
			wakeReplay: false,
		});
		await expect
			.poll(
				async () => {
					const response = await request.get(
						`${appUrl}/api/account/${collaboratorId.replace(/\D/g, "")}`,
					);
					if (!response.ok()) return false;
					const payload = (await response.json()) as {
						sharedColumns?: Array<{ id?: string }>;
					};
					return payload.sharedColumns?.some((column) => column.id === columnId) ?? false;
				},
				{ timeout: 15000 },
			)
			.toBe(true);

		await expect(async () => {
			await collaboratorPage.reload();
			await expect(
				collaboratorPage.getByText(`Shared by ${ownerShort}`),
			).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 30000, intervals: [500, 1000, 2000] });

		await ownerContext.close();
		await collaboratorContext.close();
	});

	test("replays queued public link toggles after temporary backend outage", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, ownerId);
		await addColumnAndGetId(page);
		await page.getByRole("button", { name: "Share column" }).first().click();

		await withTemporaryBackendOutage(
			page,
			"**/api/column/**/public",
			async () => {
				await page.getByRole("button", { name: "Enable public link" }).click();
				await expect(page.getByRole("button", { name: "Enable public link" })).toBeVisible();
				await waitForQueuedMutations(page, ownerId);
			},
		);

		await waitForQueueToDrain(page, ownerId);

		await expect(page.getByRole("button", { name: "Disable" })).toBeVisible();

		await withTemporaryBackendOutage(
			page,
			"**/api/column/**/public",
			async () => {
				await page.getByRole("button", { name: "Disable" }).click();
				await waitForQueuedMutations(page, ownerId);
			},
		);

		await waitForQueueToDrain(page, ownerId);

		await page.reload();
		await page.getByRole("button", { name: "Share column" }).first().click();
		await expect(page.getByRole("button", { name: "Enable public link" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Disable" })).toHaveCount(0);
	});

	test("replays queued delete and restore after temporary backend outage", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);
		const firstColumnId = await createColumn(request, appUrl, ownerId);
		await createColumn(request, appUrl, ownerId);

		await bootstrapAuthenticatedPage(page, ownerId);
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
			timeout: 15000,
		});

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;

		await withTemporaryBackendOutage(
			page,
			`**/api/column/${firstColumnId}`,
			async () => {
				await page.locator('button[title="Delete column"]').first().click();
				await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1, {
					timeout: 15000,
				});
				await waitForQueuedMutations(page, ownerId);
			},
		);

		await waitForQueueToDrain(page, ownerId);

		await page.reload();
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1, {
			timeout: 15000,
		});

		await withTemporaryBackendOutage(
			page,
			`**/api/column/${firstColumnId}/restore`,
			async () => {
				await page.getByRole("button", { name: ownerShort }).click();
				await page.getByRole("menuitem", { name: /Recently Deleted/ }).click();
				await expect(page.getByRole("heading", { name: "Recently Deleted" })).toBeVisible();
				await page.getByRole("button", { name: "Restore" }).click();
				await expect(page.getByText("No recently deleted columns.")).toBeVisible();
				await page.getByRole("button", { name: "Close" }).click();

				await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
					timeout: 15000,
				});
				await waitForQueuedMutations(page, ownerId);
			},
		);

		await waitForQueueToDrain(page, ownerId);

		await page.reload();
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
			timeout: 15000,
		});
	});

	test("replays queued reorder after temporary backend outage", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, ownerId);
		await createColumn(request, appUrl, ownerId);

		const initialOrder = await getAccountColumnOrder(request, appUrl, ownerId);
		expect(initialOrder.length).toBeGreaterThanOrEqual(2);

		await bootstrapAuthenticatedPage(page, ownerId);
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
			timeout: 15000,
		});

		const normalizedOwnerId = ownerId.replace(/\D/g, "");

		const dragColumn = async (fromIndex: number, toIndex: number) => {
			const handles = page.locator("button.cursor-grab");
			const source = handles.nth(fromIndex);
			const target = handles.nth(toIndex);

			await expect(source).toBeVisible();
			await expect(target).toBeVisible();

			const sourceBox = await source.boundingBox();
			const targetBox = await target.boundingBox();

			if (!sourceBox || !targetBox) {
				throw new Error("Missing drag handle bounds");
			}

			await page.mouse.move(
				sourceBox.x + sourceBox.width / 2,
				sourceBox.y + sourceBox.height / 2,
			);
			await page.mouse.down();
			await page.mouse.move(
				targetBox.x + targetBox.width / 2,
				targetBox.y + targetBox.height / 2,
				{ steps: 24 },
			);
			await page.mouse.up();
		};

		await withTemporaryBackendOutage(
			page,
			`**/api/account/${normalizedOwnerId}/columns`,
			async () => {
				await dragColumn(0, 1);
				const queuedAfterFirstDrag =
					(await getSyncStateSnapshot(page, ownerId))?.queueDepth ?? 0;
				if (queuedAfterFirstDrag === 0) {
					await dragColumn(1, 0);
				}

				await waitForQueuedMutations(page, ownerId);
			},
		);

		await waitForQueueToDrain(page, ownerId);

		const finalOrder = await getAccountColumnOrder(request, appUrl, ownerId);
		expect(finalOrder).toHaveLength(initialOrder.length);
		expect(finalOrder[0]).toBe(initialOrder[1]);
		expect(finalOrder[1]).toBe(initialOrder[0]);
	});

	test("replays queued hide shared column after temporary backend outage", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const ownerId = await createAccount(request, appUrl);
		const collaboratorId = await createAccount(request, appUrl);

		const ownerColumnId = await createColumn(request, appUrl, ownerId);
		await createColumn(request, appUrl, collaboratorId);

		const shareResponse = await request.post(
			`${appUrl}/api/column/${ownerColumnId}/share`,
			{
				headers: {
					"Content-Type": "application/json",
					"X-Account-ID": ownerId,
				},
				data: {
					targetAccountId: collaboratorId,
				},
			},
		);
		expect(shareResponse.ok()).toBeTruthy();

		await bootstrapAuthenticatedPage(page, collaboratorId);
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
			timeout: 15000,
		});

		const compactOwnerId = ownerId.replace(/\s/g, "");
		const ownerShort = `${compactOwnerId.slice(0, 4)}...${compactOwnerId.slice(-4)}`;
		await expect(page.getByText(`Shared by ${ownerShort}`)).toBeVisible({ timeout: 15000 });

		const normalizedCollaboratorId = collaboratorId.replace(/\D/g, "");

		await withTemporaryBackendOutage(
			page,
			`**/api/account/${normalizedCollaboratorId}/hidden`,
			async () => {
				await page.locator('button[title="Hide column"]').first().click();
				await expect(page.getByText(`Shared by ${ownerShort}`)).toHaveCount(0);
				await waitForQueuedMutations(page, collaboratorId);
			},
		);

		await waitForQueueToDrain(page, collaboratorId);

		await page.reload();
		await expect(page.getByText(`Shared by ${ownerShort}`)).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1, {
			timeout: 15000,
		});
	});
});
