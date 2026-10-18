/**
 * HTTP routes shared by the Worker and the browser client, in Hono pattern
 * syntax. The server registers each route from this table and the client
 * builds URLs from it, so a path or method exists in exactly one place.
 *
 * Account command routes live with their contracts in ./account-commands.ts.
 * Admin and staging routes are server-only and declared where they are served.
 */

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ApiRoute {
	method: HttpMethod;
	path: string;
}

export const API_ROUTES = {
	authStatus: { method: "GET", path: "/api/auth-status" },
	getAccount: { method: "GET", path: "/api/account" },
	createAccount: { method: "POST", path: "/api/account" },
	exportAccount: { method: "GET", path: "/api/account/export" },
	importAccount: { method: "POST", path: "/api/account/import" },
	getColumn: { method: "GET", path: "/api/column/:id" },
	columnWsTicket: { method: "POST", path: "/api/column/:id/ws-ticket" },
	columnWs: { method: "GET", path: "/api/column/:id/ws" },
	publicColumn: { method: "GET", path: "/api/p/:publicId" },
	publicColumnWs: { method: "GET", path: "/api/p/:publicId/ws" },
	clock: { method: "GET", path: "/api/clock" },
} as const satisfies Record<string, ApiRoute>;

/** better-auth mounts its own routes under this prefix on both sides. */
export const AUTH_BASE_PATH = "/api/auth";

/** Browser page that renders a public read-only column. */
export const PUBLIC_PAGE_PATH = "/p/:publicId";

type RouteParams<P extends string> =
	P extends `${string}:${infer Name}/${infer Rest}`
		? { [K in Name]: string } & RouteParams<`/${Rest}`>
		: P extends `${string}:${infer Name}`
			? { [K in Name]: string }
			: Record<never, never>;

/** Fills a route pattern's `:name` parameters, URL-encoding each value. */
export function routePath<P extends string>(pattern: P, params: RouteParams<P>): string {
	return pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
		const value = (params as Record<string, string | undefined>)[name];
		if (value === undefined) throw new Error(`Missing route parameter ${name} for ${pattern}`);
		return encodeURIComponent(value);
	});
}

export function publicPageUrl(origin: string, publicId: string): string {
	return `${origin}${routePath(PUBLIC_PAGE_PATH, { publicId })}`;
}

/** Returns the public ID when a browser pathname is a public column page. */
export function matchPublicPagePath(pathname: string): string | null {
	return /^\/p\/([a-zA-Z0-9]+)$/.exec(pathname)?.[1] ?? null;
}
