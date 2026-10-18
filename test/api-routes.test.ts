import { describe, expect, it } from "vitest";
import {
	API_ROUTES,
	matchPublicPagePath,
	publicPageUrl,
	routePath,
} from "../src/lib/api/routes";

describe("shared API routes", () => {
	it("fills and encodes route parameters", () => {
		expect(routePath(API_ROUTES.columnWs.path, { id: "a/b" })).toBe("/api/column/a%2Fb/ws");
		expect(routePath(API_ROUTES.getAccount.path, {})).toBe("/api/account");
	});

	it("requires every route parameter at compile time", () => {
		// @ts-expect-error columnWsTicket needs an id.
		expect(() => routePath(API_ROUTES.columnWsTicket.path, {})).toThrow("Missing route parameter id");
	});

	it("builds and recognizes the same public page path", () => {
		const url = publicPageUrl("https://todo.example", "x7Km9p2N");
		expect(url).toBe("https://todo.example/p/x7Km9p2N");
		expect(matchPublicPagePath(new URL(url).pathname)).toBe("x7Km9p2N");
		expect(matchPublicPagePath("/p/x7Km9p2N/extra")).toBeNull();
	});
});
