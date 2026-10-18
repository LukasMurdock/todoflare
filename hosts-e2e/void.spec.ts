import { expect, test } from "@playwright/test";

test("the server renders the board with its content", async ({ request }) => {
	const html = await (await request.get("/")).text();
	expect(html).toContain("data-todo-board");
	expect(html).toContain("Rendered on the server");
	expect(html).toContain("Editable after hydration");
	expect(html).toContain('aria-label="Add column"');
	expect(html).toContain('data-hydrate="load"');
});

test("the server HTML is the finished board, before any JavaScript", async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto("/");
	const board = page.locator("[data-todo-board]");
	await expect(board.getByText("Rendered on the server")).toBeVisible();
	// Snapshot checkboxes are decorative (aria-hidden), so select them by role attribute.
	await expect(board.locator("[role=checkbox]")).toHaveCount(2);
	await expect(board.locator("[role=checkbox]").first()).toHaveAttribute("data-state", "checked");
	await context.close();
});

test("hydrates without mismatches and becomes editable", async ({ page }) => {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || /hydrat/i.test(message.text())) problems.push(message.text().slice(0, 300));
	});
	await page.goto("/");
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await expect(editor).toBeVisible();
	await editor.getByText("Editable after hydration").click();
	await page.keyboard.type("[typed]");
	await expect(editor).toContainText("[typed]");
	await expect(editor).toContainText("Rendered on the server");
	await page.locator("[data-todo-board]").getByRole("button", { name: "Add column" }).click();
	await expect(page.getByRole("textbox", { name: "Todo editor" })).toHaveCount(2);
	expect(problems).toEqual([]);
});

test("hydration swaps in the editor without a visible change", async ({ browser }) => {
	const shot = async (javaScriptEnabled: boolean) => {
		const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1100, height: 640 } });
		const page = await context.newPage();
		await page.goto("/");
		if (javaScriptEnabled) await expect(page.getByRole("textbox", { name: "Todo editor" })).toBeVisible();
		// The column's top 300px: headers and content. The shortcuts button sits lower and
		// switches from "Ctrl" to "⌘" on Apple platforms after hydration, by design.
		const box = (await page.locator("[data-column-id]").first().boundingBox())!;
		const image = await page.screenshot({
			animations: "disabled",
			caret: "hide",
			clip: { x: box.x, y: box.y, width: box.width, height: 300 },
		});
		await context.close();
		return image;
	};
	expect((await shot(true)).equals(await shot(false))).toBe(true);
});

test("the page's hostile global CSS does not restyle the board", async ({ page }) => {
	await page.goto("/");
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await expect(editor).toBeVisible();
	const styles = await editor.evaluate((element) => {
		const li = element.querySelector("li")!;
		const checkbox = element.querySelector("[role=checkbox]")!;
		return {
			font: getComputedStyle(li).fontFamily,
			listStyle: getComputedStyle(li).listStyleType,
			checkboxBorder: getComputedStyle(checkbox).borderTopWidth,
		};
	});
	expect(styles.font).not.toMatch(/^serif/);
	expect(styles).toMatchObject({ listStyle: "none", checkboxBorder: "1px" });
	// The host's own heading does get the hostile serif font.
	expect(await page.getByRole("heading", { name: "Void host" }).evaluate((h) => getComputedStyle(h).fontFamily)).toMatch(/^serif/);
});
