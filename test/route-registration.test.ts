import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_COMMANDS } from "../src/lib/api/account-commands";
import { API_ROUTES } from "../src/lib/api/routes";

const SAMPLE_PARAMS: Record<string, string> = {
	id: "00000000-0000-4000-8000-000000000001",
	publicId: "x7Km9p2N",
	agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
	changeId: "chg_AAAAAAAAAAAAAAAAAAAAAA",
};

const declaredRoutes = [
	...Object.entries(API_ROUTES).map(([name, route]) => ({ name, ...route })),
	...Object.entries(ACCOUNT_COMMANDS).map(([name, { method, path }]) => ({ name, method, path })),
];

describe("route declarations", () => {
	it.each(declaredRoutes)("$name ($method $path) is served by the Worker", async ({ method, path }) => {
		const url = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => SAMPLE_PARAMS[name]);
		const response = await SELF.fetch(`http://example.com${url}`, {
			method,
			headers: { "X-Forwarded-For": "203.0.113.77" },
		});
		const body = await response.text();
		// Hono's fallback for an unregistered route; every handler answers differently.
		expect(response.status === 404 && body === "404 Not Found").toBe(false);
	});

	it("detects an unregistered route", async () => {
		const response = await SELF.fetch("http://example.com/api/not-a-route");
		expect([response.status, await response.text()]).toEqual([404, "404 Not Found"]);
	});
});
