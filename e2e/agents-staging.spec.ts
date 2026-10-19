// Agent access on a deployed origin: real passkey session, real HTTPS,
// the real Claude Code CLI with a personal token, and the official MCP SDK's
// OAuth client approved through the consent page. Run with
// `pnpm test:staging:agents`; it makes one real model call.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { expect, test } from "@playwright/test";
import { getYjsOutboxCountForColumn } from "./helpers/local-first-readers";
import { signInWithNewPasskey } from "./helpers/passkey-session";
import { addColumnAndGetId } from "./helpers/ui-session";

const REDIRECT = "http://127.0.0.1:33420/callback";

class MemoryProvider implements OAuthClientProvider {
	client?: OAuthClientInformationMixed;
	saved?: OAuthTokens;
	verifier = "";
	authorizationUrl?: URL;
	readonly redirectUrl = REDIRECT;
	readonly clientMetadata = { client_name: "Staging SDK check", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
	clientInformation() {
		return this.client;
	}
	saveClientInformation(client: OAuthClientInformationMixed) {
		this.client = client;
	}
	tokens() {
		return this.saved;
	}
	saveTokens(tokens: OAuthTokens) {
		this.saved = tokens;
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
}

test("agent access works end to end on staging", async ({ page, context, baseURL }) => {
	test.setTimeout(300_000);
	const origin = baseURL!;
	const accountId = await signInWithNewPasskey(page, context);
	const columnId = await addColumnAndGetId(page);
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type("Staging errands");
	// The server must have the edit, not just the page: titles are read on the server.
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBe(0);

	// 1. A personal token for Claude Code, with edit access granted in the dialog.
	const compact = accountId.replace(/\D/g, "");
	await page.getByRole("button", { name: `${compact.slice(0, 4)}...${compact.slice(-4)}` }).click();
	await page.getByRole("menuitem", { name: "Agents" }).click();
	const dialog = page.getByRole("dialog", { name: "Agents" });
	await dialog.getByRole("textbox", { name: "Agent name" }).fill("Claude Code (staging)");
	await dialog.getByRole("button", { name: "Create token" }).click();
	const token = (await dialog.getByTestId("agent-token").locator("code").first().textContent())!.trim();
	await dialog.getByRole("combobox", { name: "Give Claude Code (staging) a column" }).selectOption({ label: "Staging errands" });
	await dialog.getByRole("combobox", { name: "Claude Code (staging) access to Staging errands" }).selectOption("edit");
	await expect(dialog.getByRole("combobox", { name: "Claude Code (staging) access to Staging errands" })).toHaveValue("edit");
	await page.keyboard.press("Escape");

	// 2. The real Claude Code CLI adds an item; it appears live in the person's editor.
	const dir = await mkdtemp(path.join(tmpdir(), "todoflare-staging-mcp-"));
	const config = path.join(dir, "mcp.json");
	await writeFile(config, JSON.stringify({ mcpServers: { todoflare: { type: "http", url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
	try {
		const { stdout } = await promisify(execFile)(
			"claude",
			["-p", 'Using the todoflare tools, add a todo "Buy stamps" to my Staging errands column. Change nothing else.', "--mcp-config", config, "--strict-mcp-config", "--allowedTools", "mcp__todoflare", "--output-format", "json"],
			{ encoding: "utf8", timeout: 180_000 },
		);
		console.log("Claude:", JSON.parse(stdout).result);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	await expect(editor).toContainText("Buy stamps", { timeout: 15_000 });

	// 3. The person sees the change in the column and undoes it.
	await page.getByRole("button", { name: "Agents for this column" }).first().click();
	const change = page.getByTestId("agent-change").first();
	await expect(change).toContainText('Added "Buy stamps"');
	await expect(change).toContainText("Claude Code (staging)");
	await change.getByRole("button", { name: /^Undo/ }).click();
	await expect(editor).not.toContainText("Buy stamps");
	await page.keyboard.press("Escape");

	// 4. The official MCP SDK's OAuth client connects through discovery, registration and consent.
	const provider = new MemoryProvider();
	const endpoint = new URL(`${origin}/api/mcp`);
	const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
	await expect(new Client({ name: "staging-check", version: "1.0.0" }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
	let callback: URL | null = null;
	await page.route("http://127.0.0.1:33420/**", async (route) => {
		callback = new URL(route.request().url());
		await route.fulfill({ status: 200, body: "done" });
	});
	await page.goto(provider.authorizationUrl!.toString());
	await expect(page.getByTestId("consent-client-name")).toHaveText("Staging SDK check wants to use Todoflare");
	await page.getByRole("combobox", { name: "Access to Staging errands" }).selectOption("read");
	await page.getByRole("button", { name: "Allow 1 column" }).click();
	await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
	expect(callback!.searchParams.get("iss")).toBe(origin);
	await transport.finishAuth(callback!.searchParams.get("code")!);
	const client = new Client({ name: "staging-check", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
	expect((await client.callTool({ name: "list_columns", arguments: {} })).structuredContent).toEqual({
		columns: [{ columnId, title: "Staging errands", level: "read" }],
	});
	const refused = await client.callTool({ name: "append_items", arguments: { columnId, items: [{ text: "not allowed" }] } });
	expect(refused.isError).toBe(true);
	await client.close();

	// 5. Disconnecting both cuts both off.
	await page.goto("/");
	await page.getByRole("button", { name: `${compact.slice(0, 4)}...${compact.slice(-4)}` }).click();
	await page.getByRole("menuitem", { name: "Agents" }).click();
	for (let remaining = 2; remaining > 0; remaining--) {
		await page.getByRole("dialog", { name: "Agents" }).getByRole("button", { name: "Disconnect", exact: true }).first().click();
		await page.getByRole("dialog", { name: "Agents" }).getByRole("button", { name: "Disconnect now" }).click();
		await expect(page.getByTestId("agent-connection")).toHaveCount(remaining - 1);
	}
	for (const bearer of [token, provider.saved!.access_token]) {
		const response = await fetch(`${origin}/api/mcp`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
	}
});
