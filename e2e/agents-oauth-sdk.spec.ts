// OAuth against a real client implementation: the official MCP TypeScript
// SDK does discovery, dynamic registration, PKCE and the token exchange
// itself; Playwright only plays the person approving the consent page.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { addColumnAndGetId, bootstrapAuthenticatedPage } from "./helpers/ui-session";

const REDIRECT = "http://127.0.0.1:33419/callback";

class MemoryProvider implements OAuthClientProvider {
	client?: OAuthClientInformationMixed;
	saved?: OAuthTokens;
	verifier = "";
	authorizationUrl?: URL;
	readonly redirectUrl = REDIRECT;
	readonly clientMetadata = {
		client_name: "MCP SDK test client",
		redirect_uris: [REDIRECT],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
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

test("the official MCP SDK client signs in with OAuth and uses the granted column", async ({ page, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await bootstrapAuthenticatedPage(page, accountId);
	const columnId = await addColumnAndGetId(page);
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type("Reading list");
	await expect.poll(async () => (await page.evaluate(() => document.body.innerText)).includes("Reading list")).toBe(true);

	const provider = new MemoryProvider();
	const endpoint = new URL(`${appUrl}/api/mcp`);
	const connect = async () => {
		const client = new Client({ name: "sdk-oauth-test", version: "1.0.0" });
		await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
		return client;
	};

	// First attempt: no token. The SDK discovers the server, registers, and asks to send the person to consent.
	let transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
	await expect(new Client({ name: "sdk-oauth-test", version: "1.0.0" }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
	expect(provider.client?.client_id).toMatch(/^tfc_/);
	expect(provider.authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
	expect(provider.authorizationUrl?.searchParams.get("resource")).toBe(endpoint.toString());

	let callback: URL | null = null;
	await page.route("http://127.0.0.1:33419/**", async (route) => {
		callback = new URL(route.request().url());
		await route.fulfill({ status: 200, body: "done" });
	});
	await page.goto(provider.authorizationUrl!.toString());
	await page.getByRole("combobox", { name: "Access to Reading list" }).selectOption("read");
	await page.getByRole("button", { name: "Allow 1 column" }).click();
	await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
	expect(callback!.searchParams.get("iss")).toBe(appUrl);

	// The SDK redeems the code with its PKCE verifier, then connects.
	await transport.finishAuth(callback!.searchParams.get("code")!);
	expect(provider.saved?.access_token).toMatch(/^tfa_/);
	const client = await connect();
	const listed = await client.callTool({ name: "list_columns", arguments: {} });
	expect(listed.structuredContent).toEqual({ columns: [{ columnId, title: "Reading list", level: "read" }] });
	await client.close();

	// When the access token is no longer accepted, the SDK refreshes on its own.
	provider.saved = { ...provider.saved!, access_token: `tfa_${"A".repeat(43)}` };
	transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
	const refreshed = new Client({ name: "sdk-oauth-test", version: "1.0.0" });
	await refreshed.connect(transport).catch(async (error) => {
		// SDK 1.32 refreshes on a 401 at connect time; tolerate one explicit retry.
		if (!(error instanceof UnauthorizedError)) throw error;
		await refreshed.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
	});
	expect(provider.saved?.access_token).not.toBe(`tfa_${"A".repeat(43)}`);
	expect((await refreshed.callTool({ name: "read_column", arguments: { columnId } })).isError).toBeFalsy();
	await refreshed.close();
});
