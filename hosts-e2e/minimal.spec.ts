import { expect, test, type Page } from "@playwright/test";

const boardSection = (page: Page, name: string) => page.getByRole("region", { name: `Board ${name}` });
const log = (page: Page, name = "a") => page.getByRole("status", { name: `Log ${name}` }).or(page.getByLabel(`Log ${name}`));

async function open(page: Page, query = "") {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.goto(`/${query}`);
	const editor = boardSection(page, query.includes("cycles") ? "cycled" : "a").getByRole("textbox", { name: "Todo editor" }).first();
	return { editor, errors };
}

test("edits reach the host through onContentChange and survive a reload", async ({ page }) => {
	const { editor, errors } = await open(page);
	await editor.click();
	await page.keyboard.type("# Host list\n[] First");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => localStorage.getItem("board:a") ?? "")).toContain("First");
	await page.reload();
	await expect(editor).toContainText("Host list");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("adds, collapses and removes columns through host callbacks", async ({ page }) => {
	const { editor } = await open(page);
	await expect(editor).toBeVisible();
	const board = boardSection(page, "a");
	await board.getByRole("button", { name: "Add column" }).click();
	await expect(board.getByRole("textbox", { name: "Todo editor" })).toHaveCount(2);
	await board.getByRole("button", { name: "Collapse column" }).last().click();
	await expect(board.getByRole("button", { name: "Expand column" })).toHaveCount(1);
	await board.getByRole("button", { name: "Expand column" }).click();
	await board.getByTitle("Delete column").last().click();
	await expect(board.getByRole("textbox", { name: "Todo editor" })).toHaveCount(1);
});

test("links go to onOpenLink and host editor plugins run", async ({ page }) => {
	const { editor } = await open(page);
	await editor.click();
	await page.keyboard.type("Visit example.com ");
	await page.keyboard.press("Alt+KeyD");
	await expect(editor).toContainText("[stamp]");
	await page.keyboard.down("ControlOrMeta");
	await editor.locator(".url-text").click();
	await page.keyboard.up("ControlOrMeta");
	await expect(log(page)).toContainText("link:https://example.com");
});

test("the ref focuses, reads and scrolls columns", async ({ page }) => {
	const { editor } = await open(page);
	await editor.click();
	await page.keyboard.type("Readable");
	const board = boardSection(page, "a");
	await page.getByRole("button", { name: "Read first" }).first().click();
	await expect(log(page)).toContainText('"text":"Readable"');
	await board.getByRole("button", { name: "Add column" }).click();
	await board.getByRole("textbox", { name: "Todo editor" }).last().click();
	await page.getByRole("button", { name: "Focus first" }).first().click();
	await expect(log(page)).toContainText("focus:true");
	await expect(editor).toBeFocused();
	await page.keyboard.type(" more");
	await expect(editor).toContainText("Readable more");
});

test("adapter failures reach onError and the board stays usable", async ({ page }) => {
	await open(page, "?failing");
	await expect(log(page)).toContainText("error:open-document:storage offline");
	await expect(boardSection(page, "a").getByRole("button", { name: "Add column" })).toBeVisible();
});

test("two boards on one page are isolated", async ({ page }) => {
	await open(page, "?two");
	const a = boardSection(page, "a");
	const b = boardSection(page, "b");
	await a.getByRole("textbox", { name: "Todo editor" }).click();
	await page.keyboard.type("Only in A");
	await expect(b.getByRole("textbox", { name: "Todo editor" })).not.toContainText("Only in A");

	await page.keyboard.press("ControlOrMeta+/");
	await expect(a.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await page.keyboard.press("Escape");

	await b.getByRole("button", { name: "Keyboard shortcuts" }).click();
	await expect(b.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("works under React StrictMode", async ({ page }) => {
	const { editor, errors } = await open(page, "?strict");
	await editor.click();
	await page.keyboard.type("Strict once");
	await expect(editor).toHaveText("Strict once");
	expect(errors).toEqual([]);
});

test("hostile host CSS does not restyle the board", async ({ page }) => {
	const { editor } = await open(page, "?hostile");
	await editor.click();
	await page.keyboard.type("[] Styled");
	const styles = await editor.evaluate((element) => {
		const li = element.querySelector("li")!;
		const checkbox = element.querySelector("[role=checkbox]")!;
		const text = getComputedStyle(li);
		return {
			font: text.fontFamily,
			lineHeight: parseFloat(text.lineHeight) / parseFloat(text.fontSize),
			listStyle: text.listStyleType,
			margin: getComputedStyle(li).marginTop,
			checkboxBorder: getComputedStyle(checkbox).borderTopWidth,
			boxSizing: getComputedStyle(checkbox).boxSizing,
		};
	});
	expect(styles.font).not.toMatch(/^serif/);
	expect(styles.lineHeight).toBeLessThan(2);
	expect(styles).toMatchObject({ listStyle: "none", margin: "0px", checkboxBorder: "1px", boxSizing: "border-box" });
});

test("mounting and unmounting 50 times leaks no listeners or nodes", async ({ page }) => {
	await open(page, "?cycles");
	const toggle = page.getByRole("button", { name: "Toggle board" });
	const editor = boardSection(page, "cycled").getByRole("textbox", { name: "Todo editor" });
	const client = await page.context().newCDPSession(page);
	await client.send("Performance.enable");
	const measure = async () => {
		await client.send("HeapProfiler.collectGarbage");
		const { metrics } = await client.send("Performance.getMetrics");
		const get = (name: string) => metrics.find((metric) => metric.name === name)!.value;
		return { listeners: get("JSEventListeners"), nodes: get("Nodes") };
	};
	const cycle = async () => {
		await toggle.click();
		await expect(editor).toHaveCount(0);
		await toggle.click();
		await expect(editor).toBeVisible();
	};
	for (let i = 0; i < 5; i++) await cycle();
	const before = await measure();
	for (let i = 0; i < 50; i++) await cycle();
	const after = await measure();
	// A leak of even one listener or node per mount would add 50.
	expect(after.listeners - before.listeners).toBeLessThan(25);
	expect(after.nodes - before.nodes).toBeLessThan(25);
});
