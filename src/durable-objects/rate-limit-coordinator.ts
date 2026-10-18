import { DurableObject } from "cloudflare:workers";

interface RateLimitRequest {
	limit: number;
	windowSeconds: number;
}

interface RateLimitRow extends Record<string, SqlStorageValue> {
	window_start: number;
	count: number;
	expires_at: number;
}

export class RateLimitCoordinatorSql extends DurableObject<unknown> {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS rate_limit_window (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				window_start INTEGER NOT NULL,
				count INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		// Only staging controls call this; production code paths only check.
		if (request.method === "POST" && pathname === "/reset") {
			this.ctx.storage.sql.exec("DELETE FROM rate_limit_window WHERE id = 1");
			await this.ctx.storage.deleteAlarm();
			return Response.json({ success: true });
		}
		if (request.method !== "POST" || pathname !== "/check") {
			return new Response("Not Found", { status: 404 });
		}

		const input = (await request.json().catch(() => null)) as RateLimitRequest | null;
		if (
			!input ||
			!Number.isInteger(input.limit) ||
			input.limit <= 0 ||
			!Number.isInteger(input.windowSeconds) ||
			input.windowSeconds <= 0
		) {
			return Response.json({ error: "Invalid rate-limit request" }, { status: 400 });
		}

		const now = Math.floor(Date.now() / 1000);
		const windowStart = now - (now % input.windowSeconds);
		const resetAt = windowStart + input.windowSeconds;
		const row =
			this.ctx.storage.sql
				.exec<RateLimitRow>(
					"SELECT window_start, count, expires_at FROM rate_limit_window WHERE id = 1",
				)
				.toArray()[0] ?? null;
		const current = row?.window_start === windowStart ? row.count : 0;

		if (current >= input.limit) {
			return Response.json({
				allowed: false,
				remaining: 0,
				retryAfter: Math.max(1, resetAt - now),
			});
		}

		const next = current + 1;
		this.ctx.storage.sql.exec(
			"INSERT INTO rate_limit_window (id, window_start, count, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, expires_at = excluded.expires_at",
			windowStart,
			next,
			resetAt,
		);
		await this.ctx.storage.setAlarm(resetAt * 1000);

		return Response.json({
			allowed: true,
			remaining: input.limit - next,
		});
	}

	async alarm(): Promise<void> {
		const row =
			this.ctx.storage.sql
				.exec<RateLimitRow>(
					"SELECT window_start, count, expires_at FROM rate_limit_window WHERE id = 1",
				)
				.toArray()[0] ?? null;
		if (!row) return;
		if (row.expires_at <= Math.floor(Date.now() / 1000)) {
			this.ctx.storage.sql.exec("DELETE FROM rate_limit_window WHERE id = 1");
			return;
		}
		await this.ctx.storage.setAlarm(row.expires_at * 1000);
	}
}
