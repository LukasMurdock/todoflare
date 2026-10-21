// What crawlers and agents find before they connect: robots.txt, llms.txt,
// the MCP server card and the RFC 9727 API catalog.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../src/lib/api/routes";
import { agentToolDescriptors } from "../src/server/agent-access/tools";
import { llmsTxt, robotsTxt } from "../src/server/routes/discovery";
import { BASE } from "./helpers/agent-fixtures";

function fetchRoute(route: { path: string }) {
	return SELF.fetch(`${BASE}${route.path}`);
}

describe("robots.txt", () => {
	it("is served as plain text for this environment", async () => {
		const response = await fetchRoute(API_ROUTES.robotsTxt);
		expect(response.headers.get("Content-Type")).toContain("text/plain");
		expect(await response.text()).toBe(robotsTxt(env, BASE));
	});

	it("keeps every non-production environment out of indexes", () => {
		expect(robotsTxt({ ENVIRONMENT: "staging" }, BASE)).toBe("User-agent: *\nDisallow: /\n");
		expect(robotsTxt({}, BASE)).toBe("User-agent: *\nDisallow: /\n");
	});

	it("in production, allows the front page and discovery but not public links, OAuth or the API", () => {
		const lines = robotsTxt({ ENVIRONMENT: "production" }, BASE).split("\n");
		expect(lines).toEqual(
			expect.arrayContaining([
				"User-agent: *",
				"Content-Signal: search=yes, ai-input=yes, ai-train=no",
				"Allow: /$",
				"Allow: /llms.txt",
				"Allow: /.well-known/",
				"Disallow: /p/",
				"Disallow: /oauth/authorize",
				"Disallow: /api/",
			]),
		);
	});
});

describe("llms.txt", () => {
	it("is Markdown that points at the MCP endpoint and its OAuth metadata", async () => {
		const response = await fetchRoute(API_ROUTES.llmsTxt);
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		const text = await response.text();
		expect(text.startsWith("# Todoflare\n\n> ")).toBe(true);
		expect(text).toContain(`(${BASE}/api/mcp)`);
		expect(text).toContain(`(${BASE}/.well-known/oauth-protected-resource/api/mcp)`);
		expect(text).toContain(`(${BASE}/.well-known/mcp/server-card.json)`);
		for (const tool of agentToolDescriptors()) expect(text).toContain(`\`${tool.name}\``);
	});

	it("says nothing about connecting when agent access is off", () => {
		const text = llmsTxt(BASE, false);
		expect(text).toContain("not enabled");
		expect(text).not.toContain("/api/mcp");
	});
});

describe("MCP server card", () => {
	it("describes the endpoint, its OAuth discovery and its tools", async () => {
		const response = await fetchRoute(API_ROUTES.mcpServerCard);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const card = (await response.json()) as Record<string, unknown>;
		expect(card).toMatchObject({
			protocolVersion: "2026-07-28",
			serverInfo: { name: "todoflare" },
			transport: { type: "streamable-http", endpoint: `${BASE}/api/mcp` },
			authentication: { required: true, protectedResourceMetadata: `${BASE}/.well-known/oauth-protected-resource/api/mcp` },
		});
		expect((card.tools as { name: string }[]).map((tool) => tool.name)).toEqual(agentToolDescriptors().map((tool) => tool.name));
	});

	it("matches what the 401 challenge points at", async () => {
		const card = (await (await fetchRoute(API_ROUTES.mcpServerCard)).json()) as { authentication: { protectedResourceMetadata: string } };
		const challenge = (await SELF.fetch(`${BASE}${API_ROUTES.mcp.path}`, { method: "POST", body: "{}" })).headers.get("WWW-Authenticate")!;
		expect(challenge).toContain(`resource_metadata="${card.authentication.protectedResourceMetadata}"`);
	});
});

describe("API catalog", () => {
	it("is an RFC 9727 linkset listing the MCP endpoint and its descriptions", async () => {
		const response = await fetchRoute(API_ROUTES.apiCatalog);
		expect(response.headers.get("Content-Type")).toContain("application/linkset+json");
		expect(response.headers.get("Link")).toBe(`<${BASE}/.well-known/api-catalog>; rel="api-catalog"`);
		const { linkset } = (await response.json()) as { linkset: Record<string, unknown>[] };
		expect(linkset[0]).toMatchObject({ anchor: `${BASE}/.well-known/api-catalog`, item: [{ href: `${BASE}/api/mcp` }] });
		expect(linkset[1]).toMatchObject({
			anchor: `${BASE}/api/mcp`,
			"service-desc": [{ href: `${BASE}/.well-known/mcp/server-card.json` }],
			"service-doc": [{ href: `${BASE}/llms.txt` }],
			"service-meta": [{ href: `${BASE}/.well-known/oauth-protected-resource/api/mcp` }],
		});
	});
});
