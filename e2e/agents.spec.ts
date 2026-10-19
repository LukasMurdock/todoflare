import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { getYjsOutboxCountForColumn } from "./helpers/local-first-readers";
import { addColumnAndGetId, bootstrapAuthenticatedPage } from "./helpers/ui-session";

const REDIRECT = "http://127.0.0.1:33418/callback";

function shortId(accountId: string): string {
	const compact = accountId.replace(/\D/g, "");
	return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

async function mcpCall(request: APIRequestContext, baseURL: string, token: string, name: string, args: Record<string, unknown>) {
	const response = await request.post(`${baseURL}/api/mcp`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
	});
	expect(response.status()).toBe(200);
	return ((await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }).result;
}

/** Types into the first column and waits until the server has the edit, not just the page. */
async function typeIntoFirstColumn(page: Page, accountId: string, columnId: string, text: string) {
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type(text);
	await expect(editor).toContainText(text);
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBe(0);
}

async function openAgentsDialog(page: Page, accountId: string) {
	await page.getByRole("button", { name: shortId(accountId) }).click();
	await page.getByRole("menuitem", { name: "Agents" }).click();
	await expect(page.getByRole("dialog", { name: "Agents" })).toBeVisible();
}

test.describe("agents", () => {
	test("a person connects an agent, the agent edits, and the person undoes it", async ({ page, request, baseURL }) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await bootstrapAuthenticatedPage(page, accountId);
		const columnId = await addColumnAndGetId(page);
		await typeIntoFirstColumn(page, accountId, columnId, "Groceries");

		// Follow the Claude Code steps: choose the column first, then get the command.
		await openAgentsDialog(page, accountId);
		const dialog = page.getByRole("dialog", { name: "Agents" });
		await dialog.getByRole("button", { name: /^Claude Code/ }).click();
		await expect(dialog.getByRole("button", { name: "Choose a column first" })).toBeDisabled();
		await expect(dialog).toContainText("You can change these any time under Agents, without a new command.");
		await dialog.getByRole("combobox", { name: "Access to Groceries" }).selectOption("read");
		await dialog.getByRole("textbox", { name: "Agent name" }).fill("Test agent");
		await dialog.getByRole("button", { name: "Connect with 1 column" }).click();
		await expect(dialog.getByTestId("agent-token")).toContainText("Test agent can use 1 column");
		const command = (await dialog.getByTestId("agent-token").locator("code").first().textContent())!.trim();
		// User scope, so the connection works in every folder, not only where the command ran.
		expect(command).toContain(`claude mcp add --scope user --transport http todoflare ${appUrl}/api/mcp`);
		const token = /Bearer (tfa_[A-Za-z0-9_-]+)"/.exec(command)![1]!;
		await dialog.getByRole("button", { name: "Done" }).click();
		await expect(dialog.getByRole("combobox", { name: "Test agent access to Groceries" })).toHaveValue("read");
		await page.keyboard.press("Escape");

		// Read access: it can read, but not write.
		const read = await mcpCall(request, appUrl, token, "read_column", { columnId });
		expect(read.structuredContent?.markdown).toContain("Groceries");
		const refused = await mcpCall(request, appUrl, token, "append_items", { columnId, items: [{ text: "Milk" }] });
		expect(refused.isError).toBe(true);

		// Raise it to "Add items" from the column itself.
		await page.getByRole("button", { name: "Agents for this column" }).first().click();
		await page.getByRole("combobox", { name: "Test agent access to this column" }).selectOption("append");
		await expect(page.getByRole("combobox", { name: "Test agent access to this column" })).toHaveValue("append");
		await page.keyboard.press("Escape");

		// The agent's item appears live in the person's editor.
		const added = await mcpCall(request, appUrl, token, "append_items", { columnId, items: [{ text: "Milk from the agent" }] });
		expect(added.isError).toBeUndefined();
		await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("Milk from the agent");

		// The change is listed with the agent's name, and undo removes it.
		await page.getByRole("button", { name: "Agents for this column" }).first().click();
		const change = page.getByTestId("agent-change").first();
		await expect(change).toContainText('Added "Milk from the agent"');
		await expect(change).toContainText("Test agent");
		await change.getByRole("button", { name: /^Undo/ }).click();
		await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).not.toContainText("Milk from the agent");
		await expect(change).toContainText("Undone");
		await page.keyboard.press("Escape");

		// Disconnecting cuts it off.
		await openAgentsDialog(page, accountId);
		await page.getByRole("dialog", { name: "Agents" }).getByRole("button", { name: "Disconnect", exact: true }).click();
		await page.getByRole("dialog", { name: "Agents" }).getByRole("button", { name: "Disconnect now" }).click();
		await expect(page.getByRole("dialog", { name: "Agents" })).toContainText("No agents connected.");
		const afterRevoke = await request.post(`${appUrl}/api/mcp`, {
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});
		expect(afterRevoke.status()).toBe(401);
	});

	test("an MCP client connects through OAuth with the columns the person chose", async ({ page, request, baseURL }) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await bootstrapAuthenticatedPage(page, accountId);
		const columnId = await addColumnAndGetId(page);
		await typeIntoFirstColumn(page, accountId, columnId, "Launch plan");

		// The client discovers the server and registers itself, as Claude does.
		const challenge401 = await request.post(`${appUrl}/api/mcp`, { data: {} });
		expect(challenge401.status()).toBe(401);
		const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge401.headers()["www-authenticate"]!)![1]!;
		const issuer = ((await (await request.get(resourceMetadataUrl)).json()) as { authorization_servers: string[] }).authorization_servers[0]!;
		const metadata = (await (await request.get(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
		const registration = await request.post(metadata.registration_endpoint!, {
			headers: { "X-Forwarded-For": `10.20.${Math.floor(Math.random() * 200)}.1` },
			data: { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
		});
		const { client_id: clientId } = (await registration.json()) as { client_id: string };

		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorize = new URL(metadata.authorization_endpoint!);
		for (const [key, value] of Object.entries({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "state-123",
			resource: `${appUrl}/api/mcp`,
		})) authorize.searchParams.set(key, value);

		// The client's local callback server, standing in for Claude Code's.
		let callback: URL | null = null;
		await page.route("http://127.0.0.1:33418/**", async (route) => {
			callback = new URL(route.request().url());
			await route.fulfill({ status: 200, contentType: "text/plain", body: "You can close this tab." });
		});

		await page.goto(authorize.toString());
		await expect(page.getByTestId("consent-client-name")).toHaveText("Claude wants to use Todoflare");
		await expect(page.getByText("127.0.0.1:33418")).toBeVisible();
		await expect(page.getByText("This app runs on your own computer")).toBeVisible();
		await expect(page.getByText("has not verified who made it")).toBeVisible();
		await page.getByRole("combobox", { name: "Access to Launch plan" }).selectOption("edit");
		await page.getByRole("button", { name: "Allow 1 column" }).click();

		await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
		expect(callback!.searchParams.get("state")).toBe("state-123");
		expect(callback!.searchParams.get("iss")).toBe(issuer);

		const tokenResponse = await request.post(metadata.token_endpoint!, {
			form: {
				grant_type: "authorization_code",
				code: callback!.searchParams.get("code")!,
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_verifier: verifier,
				resource: `${appUrl}/api/mcp`,
			},
		});
		expect(tokenResponse.status()).toBe(200);
		const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };
		const listed = await mcpCall(request, appUrl, accessToken, "list_columns", {});
		expect(listed.structuredContent).toEqual({ columns: [{ columnId, title: "Launch plan", level: "edit" }] });

		// The connection shows up for the person, marked as a sign-in connection.
		await page.goto("/");
		await openAgentsDialog(page, accountId);
		const connection = page.getByTestId("agent-connection");
		await expect(connection).toContainText("Claude");
		await expect(connection).toContainText("Connected with sign-in");
		await expect(connection.getByRole("combobox", { name: "Claude access to Launch plan" })).toHaveValue("edit");
	});

	test("declining sends the app back with access_denied and nothing connected", async ({ page, request, baseURL }) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await bootstrapAuthenticatedPage(page, accountId);
		const registration = await request.post(`${appUrl}/api/oauth/register`, {
			headers: { "X-Forwarded-For": `10.30.${Math.floor(Math.random() * 200)}.1` },
			data: { client_name: "Some app", redirect_uris: [REDIRECT] },
		});
		const { client_id: clientId } = (await registration.json()) as { client_id: string };
		let callback: URL | null = null;
		await page.route("http://127.0.0.1:33418/**", async (route) => {
			callback = new URL(route.request().url());
			await route.fulfill({ status: 200, body: "ok" });
		});
		const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
		await page.goto(`/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`);
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect.poll(() => callback?.searchParams.get("error") ?? null).toBe("access_denied");
		expect(callback!.searchParams.get("state")).toBe("s1");
		expect(callback!.searchParams.has("code")).toBe(false);

		await page.goto("/");
		await openAgentsDialog(page, accountId);
		await expect(page.getByRole("dialog", { name: "Agents" })).toContainText("No agents connected.");
	});

	test("the ChatGPT steps give everything its custom MCP server form asks for", async ({ page, request, baseURL }) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await bootstrapAuthenticatedPage(page, accountId);
		await openAgentsDialog(page, accountId);
		const dialog = page.getByRole("dialog", { name: "Agents" });
		await dialog.getByRole("button", { name: /^ChatGPT/ }).click();
		await expect(dialog.getByRole("heading", { name: "Connect ChatGPT" })).toBeVisible();
		await expect(dialog.getByRole("link", { name: "Open ChatGPT plugins" })).toHaveAttribute("href", "https://chatgpt.com/plugins");
		const values = (await dialog.locator("code").allTextContents()).map((text) => text.trim());
		expect(values).toEqual(["Todoflare", "Read and update my Todoflare todo columns", `${appUrl}/api/mcp`]);
		await expect(dialog).toContainText("Leave Authentication on OAuth.");

		// ChatGPT accepts a PNG icon of at most 10 KB; 256 px or larger looks best.
		const downloadPromise = page.waitForEvent("download");
		await dialog.getByRole("link", { name: "Download icon" }).click();
		expect((await downloadPromise).suggestedFilename()).toBe("todoflare-icon.png");
		const icon = await request.get(`${appUrl}/todoflare-icon.png`);
		expect(icon.headers()["content-type"]).toBe("image/png");
		const bytes = await icon.body();
		expect(bytes.byteLength).toBeLessThanOrEqual(10 * 1024);
		expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([256, 256]);

		await dialog.getByRole("button", { name: "Done" }).click();
		await expect(dialog.getByRole("button", { name: /^ChatGPT/ })).toBeVisible();
	});

	test("an untrustworthy request never redirects", async ({ page }) => {
		await page.goto(`/oauth/authorize?response_type=code&client_id=tfc_unknown&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`);
		await expect(page.getByText("This connection can’t continue")).toBeVisible();
		await expect(page.getByRole("button", { name: "Return to the app" })).toHaveCount(0);
	});
});
