import type { MiddlewareHandler } from "hono";

declare const __TODOFLARE_E2E__: boolean;

/**
 * Reads whatever request body a handler left unread, in E2E builds only.
 *
 * Local Miniflare reuses its connection to workerd, and workerd closes a
 * connection whose request body was never read, so the next request on it
 * is reset and `vite preview` answers with the SPA page instead
 * (cloudflare/workers-sdk #16199, #16243). Handlers that reject early, such
 * as a 401 from /api/mcp, would make an unrelated later request fail.
 * Production workerd does not have this problem, so production never pays
 * to read a body it is refusing.
 */
export const drainUnreadRequestBody: MiddlewareHandler = async (c, next) => {
	await next();
	if (typeof __TODOFLARE_E2E__ === "undefined" || !__TODOFLARE_E2E__) return;
	const body = c.req.raw.body;
	if (!body || c.req.raw.bodyUsed || body.locked) return;
	try {
		await body.pipeTo(new WritableStream());
	} catch {
		// The client went away; nothing left to protect.
	}
};
