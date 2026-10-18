import { type Context } from "hono";
import { isReadOnlyMode, readOnlyModeResponse } from "../read-only-mode";
import { type Bindings } from "../bindings";

export function shouldSkipRateLimit(c: Context<{ Bindings: Bindings }>): boolean {
	if (c.env.RATE_LIMIT_DISABLED === "true" || c.env.RATE_LIMIT_DISABLED === "1") {
		return true;
	}

	const hostname = new URL(c.req.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1";
}

export function blockWritesIfReadOnly(c: Context<{ Bindings: Bindings }>): Response | null {
	return isReadOnlyMode(c.env) ? readOnlyModeResponse() : null;
}
