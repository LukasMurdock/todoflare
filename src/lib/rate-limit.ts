/**
 * Rate limiting utilities for Cloudflare Workers
 *
 * Uses a sharded Durable Object for globally serialized counters.
 */

export interface RateLimitConfig {
	/** Maximum requests allowed in the window */
	limit: number;
	/** Window duration in seconds */
	windowSeconds: number;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	retryAfter?: number; // seconds until reset
}

interface RateLimitCoordinatorNamespace<Id> {
	idFromName(name: string): Id;
	get(id: Id): { fetch(request: Request): Promise<Response> };
}

/**
 * Rate limit configurations
 */
export const RATE_LIMITS = {
	/** Account creation: 5 per IP per hour */
	createAccount: { limit: 5, windowSeconds: 3600 },
	/** Account lookup: 20 per IP per minute */
	accountLookup: { limit: 20, windowSeconds: 60 },
	/** Public link views: 100 per column per minute */
	publicView: { limit: 100, windowSeconds: 60 },
	/** Agent MCP requests: 120 per agent connection per minute */
	agentRequest: { limit: 120, windowSeconds: 60 },
} as const;

/**
 * Check and increment rate limit
 *
 * @param coordinators - Durable Object namespace for rate limit storage
 * @param key - Unique key for this rate limit (e.g., "create-account:192.168.1.1")
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed and remaining count
 */
export async function checkRateLimit<Id>(
	coordinators: RateLimitCoordinatorNamespace<Id>,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	const stub = coordinators.get(coordinators.idFromName(key));
	const response = await stub.fetch(
		new Request("http://rate-limit/check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		}),
	);
	if (!response.ok) {
		throw new Error(`Rate limit coordinator failed: ${response.status}`);
	}
	return (await response.json()) as RateLimitResult;
}

/** Clears a rate-limit window. Used only by staging recovery controls. */
export async function resetRateLimit<Id>(
	coordinators: RateLimitCoordinatorNamespace<Id>,
	key: string,
): Promise<void> {
	const stub = coordinators.get(coordinators.idFromName(key));
	const response = await stub.fetch(new Request("http://rate-limit/reset", { method: "POST" }));
	if (!response.ok) {
		throw new Error(`Rate limit reset failed: ${response.status}`);
	}
}

/** Actions limited per client IP; staging can reset all of them for a caller. */
export const IP_RATE_LIMITED_ACTIONS = ["create-account", "account-lookup"] as const;

/**
 * Get client IP from Cloudflare request
 */
export function getClientIP(request: Request): string {
	return (
		request.headers.get("CF-Connecting-IP") ||
		request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
		"unknown"
	);
}

/**
 * Create rate limit key for IP-based limiting
 */
export function ipRateLimitKey(
	action: (typeof IP_RATE_LIMITED_ACTIONS)[number],
	ip: string,
): string {
	return `${action}:${ip}`;
}

/**
 * Create rate limit key for resource-based limiting
 */
export function resourceRateLimitKey(action: string, resourceId: string): string {
	return `${action}:${resourceId}`;
}
