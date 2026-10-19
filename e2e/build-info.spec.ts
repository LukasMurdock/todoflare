import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { bootstrapAuthenticatedPage } from "./helpers/ui-session";

test("the page, the Worker and the account menu name the same build", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await bootstrapAuthenticatedPage(page, accountId);

	const clock = (await (await request.get(`${appUrl}/api/clock`)).json()) as {
		build: { commit: string; committedAt: string | null; dirty: boolean };
	};
	expect(clock.build.commit).toMatch(/^[0-9a-f]{12}$/);
	const label = clock.build.dirty ? `${clock.build.commit}-dirty` : clock.build.commit;

	await expect(page.locator('meta[name="todoflare-build"]')).toHaveAttribute("content", label);

	const compactId = accountId.replace(/\s/g, "");
	await page.getByRole("button", { name: `${compactId.slice(0, 4)}...${compactId.slice(-4)}` }).click();
	await expect(page.getByRole("menu")).toContainText(`Build ${label} · ${clock.build.committedAt?.slice(0, 10)}`);
});
