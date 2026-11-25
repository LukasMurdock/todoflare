import { z } from "zod";
import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { bootstrapAuthenticatedPage } from "./helpers/ui-session";

test("the page, the Worker and the account menu name the same build", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await bootstrapAuthenticatedPage(page, accountId);

	const clock = z.object({
		build: z.object({ commit: z.string(), committedAt: z.string().nullable(), dirty: z.boolean() }),
	}).parse(await (await request.get(`${appUrl}/api/clock`)).json());
	expect(clock.build.commit).toMatch(/^[0-9a-f]{12}$/);
	const label = clock.build.dirty ? `${clock.build.commit}-dirty` : clock.build.commit;

	await expect(page.locator('meta[name="todoflare-build"]')).toHaveAttribute("content", label);

	const compactId = accountId.replaceAll(/\s/g, "");
	await page.getByRole("button", { name: `${compactId.slice(0, 4)}...${compactId.slice(-4)}` }).click();
	await expect(page.getByRole("menu")).toContainText(`Build ${label} · ${clock.build.committedAt?.slice(0, 10)}`);
});
