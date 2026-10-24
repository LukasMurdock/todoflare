import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshSessionMiddleware } from "better-auth/api";
import { createAuth } from "../src/server/auth";
import { AUTH_ENDPOINTS } from "../src/server/auth-policy";

interface Endpoint {
	path?: string;
	options?: { method?: string | string[]; use?: unknown[] };
}

// Every endpoint better-auth defines with Todoflare's plugin set, by
// "METHOD /path". The policy table must keep up with it across upgrades.
const endpoints = new Map<string, Endpoint>(
	Object.values(createAuth(env, "http://localhost:5173").api as Record<string, Endpoint>)
		.filter((endpoint) => endpoint?.path)
		.flatMap((endpoint) => [endpoint.options?.method ?? []].flat().map((method) => [`${method} ${endpoint.path}`, endpoint] as const)),
);

describe("auth endpoint policy", () => {
	it.each(Object.keys(AUTH_ENDPOINTS))("%s is a better-auth endpoint", (key) => {
		expect(endpoints.has(key)).toBe(true);
	});

	it("checks recent sign-in wherever better-auth would have checked freshness", () => {
		const fresh = [...endpoints]
			.filter(([key, endpoint]) => key in AUTH_ENDPOINTS && endpoint.options?.use?.includes(freshSessionMiddleware))
			.map(([key]) => key);
		expect(fresh).not.toHaveLength(0);
		for (const key of fresh) expect(AUTH_ENDPOINTS[key].recentSignIn, key).toBeDefined();
	});

	it.each([
		["POST", "/api/auth/update-user"],
		["GET", "/api/auth/list-sessions"],
		["POST", "/api/auth/sign-in/email"],
		["POST", "/api/auth/link-social"],
		["POST", "/api/auth/passkey/delete-passkey/"],
		["POST", "/api/auth/passkey/delete%2Dpasskey"],
		["GET", "/api/auth/passkey/delete-passkey"],
	])("does not serve %s %s", async (method, path) => {
		const response = await SELF.fetch(`http://localhost:5173${path}`, {
			method,
			headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
			body: method === "POST" ? "{}" : undefined,
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "not_found" });
	});
});
