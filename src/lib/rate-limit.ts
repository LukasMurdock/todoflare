/**
 * Rate limiting utilities for Cloudflare Workers
 *
 * Uses KV for storing rate limit counters with TTL
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
} as const;

/**
 * Check and increment rate limit
 *
 * @param kv - KV namespace for rate limit storage
 * @param key - Unique key for this rate limit (e.g., "create-account:192.168.1.1")
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed and remaining count
 */
export async function checkRateLimit(
	kv: KVNamespace,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	const now = Math.floor(Date.now() / 1000);
	const windowStart = now - (now % config.windowSeconds);
	const fullKey = `rate:${key}:${windowStart}`;

	// Get current count
	const currentStr = await kv.get(fullKey);
	const current = currentStr ? parseInt(currentStr, 10) : 0;

	if (current >= config.limit) {
		// Rate limited
		const retryAfter = windowStart + config.windowSeconds - now;
		return {
			allowed: false,
			remaining: 0,
			retryAfter,
		};
	}

	// Increment counter
	await kv.put(fullKey, (current + 1).toString(), {
		expirationTtl: config.windowSeconds + 60, // Extra minute buffer
	});

	return {
		allowed: true,
		remaining: config.limit - current - 1,
	};
}

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
export function ipRateLimitKey(action: string, ip: string): string {
	return `${action}:${ip}`;
}

/**
 * Create rate limit key for resource-based limiting
 */
export function resourceRateLimitKey(action: string, resourceId: string): string {
	return `${action}:${resourceId}`;
}
