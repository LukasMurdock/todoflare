import { Hono } from "hono";
import type { Context } from "hono";
import type { Account, ColumnMeta } from "./types/account";
import {
	generateAccountId,
	normalizeAccountId,
	displayAccountId,
	validateAccountId,
	generatePublicId,
} from "./lib/account";
import {
	checkRateLimit,
	getClientIP,
	ipRateLimitKey,
	resourceRateLimitKey,
	RATE_LIMITS,
} from "./lib/rate-limit";
import { ColumnRoomSql } from "./durable-objects/column-room";

// Re-export Durable Objects for Cloudflare
export { ColumnRoomSql };

type Bindings = {
	ACCOUNTS: KVNamespace;
	RATE_LIMIT: KVNamespace;
	COLUMN_ROOM: DurableObjectNamespace;
	RATE_LIMIT_DISABLED?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

function shouldSkipRateLimit(c: Context<{ Bindings: Bindings }>): boolean {
	if (c.env.RATE_LIMIT_DISABLED === "true" || c.env.RATE_LIMIT_DISABLED === "1") {
		return true;
	}

	const hostname = new URL(c.req.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1";
}

// ============================================
// Account Routes
// ============================================

/**
 * Create a new account
 * Rate limited: 5 per IP per hour
 */
app.post("/api/account", async (c) => {
	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			ipRateLimitKey("create-account", ip),
			RATE_LIMITS.createAccount,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const accountId = generateAccountId();
	const normalizedId = normalizeAccountId(accountId);

	const account: Account = {
		id: accountId,
		columnOrder: [],
		hiddenSharedColumns: [],
		createdAt: Date.now(),
	};

	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ account });
});

/**
 * Get account metadata
 * Rate limited: 20 per IP per minute
 */
app.get("/api/account/:id", async (c) => {
	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			ipRateLimitKey("account-lookup", ip),
			RATE_LIMITS.accountLookup,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const account = JSON.parse(accountData) as Account;

	// Get shared columns (columns where this account is in sharedWith)
	const sharedColumnsData = await c.env.ACCOUNTS.get(
		`shared:${normalizedId}`,
	);
	const sharedColumnIds: string[] = sharedColumnsData
		? JSON.parse(sharedColumnsData)
		: [];

	// Fetch metadata for shared columns
	const sharedColumns: ColumnMeta[] = [];
	for (const columnId of sharedColumnIds) {
				const stub = c.env.COLUMN_ROOM.get(
			c.env.COLUMN_ROOM.idFromName(columnId),
		);
		const response = await stub.fetch(new Request("http://do/meta"));
		if (response.ok) {
			const meta = (await response.json()) as ColumnMeta;
			sharedColumns.push(meta);
		}
	}

	return c.json({ account, sharedColumns });
});

/**
 * Update column order for an account
 */
app.put("/api/account/:id/columns", async (c) => {
	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const account = JSON.parse(accountData) as Account;
	const { columnOrder } = await c.req.json<{ columnOrder: string[] }>();

	account.columnOrder = columnOrder;
	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ success: true });
});

/**
 * Update hidden shared columns for an account
 */
app.put("/api/account/:id/hidden", async (c) => {
	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const account = JSON.parse(accountData) as Account;
	const { hiddenSharedColumns } = await c.req.json<{
		hiddenSharedColumns: string[];
	}>();

	account.hiddenSharedColumns = hiddenSharedColumns;
	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ success: true });
});

// ============================================
// Column Routes
// ============================================

/**
 * Create a new column
 */
app.post("/api/column", async (c) => {
	const { accountId } = await c.req.json<{ accountId: string }>();

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedAccountId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(
		`account:${normalizedAccountId}`,
	);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const account = JSON.parse(accountData) as Account;

	// Check column limit (100 per account)
	if (account.columnOrder.length >= 100) {
		return c.json({ error: "Column limit reached (100)" }, 400);
	}

	const columnId = crypto.randomUUID();
	const meta: ColumnMeta = {
		id: columnId,
		ownerId: displayAccountId(accountId),
		sharedWith: [],
		publicId: null,
		createdAt: Date.now(),
	};

	// Initialize the Durable Object
		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	await stub.fetch(
		new Request("http://do/init", {
			method: "POST",
			body: JSON.stringify(meta),
		}),
	);

	// Add to account's column order
	account.columnOrder.push(columnId);
	await c.env.ACCOUNTS.put(
		`account:${normalizedAccountId}`,
		JSON.stringify(account),
	);

	return c.json({ column: meta });
});

/**
 * Delete a column
 */
app.delete("/api/column/:id", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Only owner can delete
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can delete" }, 403);
	}

	// Remove from owner's column order
	const normalizedOwnerId = normalizeAccountId(meta.ownerId);
	const ownerData = await c.env.ACCOUNTS.get(`account:${normalizedOwnerId}`);
	if (ownerData) {
		const ownerAccount = JSON.parse(ownerData) as Account;
		ownerAccount.columnOrder = ownerAccount.columnOrder.filter(
			(id) => id !== columnId,
		);
		await c.env.ACCOUNTS.put(
			`account:${normalizedOwnerId}`,
			JSON.stringify(ownerAccount),
		);
	}

	// Remove from shared accounts' lists
	for (const sharedAccountId of meta.sharedWith) {
		const normalizedSharedId = normalizeAccountId(sharedAccountId);
		const sharedColumnsData = await c.env.ACCOUNTS.get(
			`shared:${normalizedSharedId}`,
		);
		if (sharedColumnsData) {
			const sharedColumns = JSON.parse(sharedColumnsData) as string[];
			const updated = sharedColumns.filter((id) => id !== columnId);
			await c.env.ACCOUNTS.put(
				`shared:${normalizedSharedId}`,
				JSON.stringify(updated),
			);
		}
	}

	// Delete the Durable Object
	await stub.fetch(new Request("http://do/", { method: "DELETE" }));

	return c.json({ success: true });
});

/**
 * Get column metadata
 */
app.get("/api/column/:id", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Check access
	if (accountId && validateAccountId(accountId)) {
		const normalizedAccountId = normalizeAccountId(accountId);
		const isOwner =
			normalizeAccountId(meta.ownerId) === normalizedAccountId;
		const isShared = meta.sharedWith.some(
			(id) => normalizeAccountId(id) === normalizedAccountId,
		);

		if (!isOwner && !isShared) {
			return c.json({ error: "Access denied" }, 403);
		}
	} else {
		return c.json({ error: "Access denied" }, 403);
	}

	return c.json({ column: meta });
});

/**
 * WebSocket connection for column sync
 */
app.get("/api/column/:id/ws", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.query("accountId");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	// Important: forward the original upgrade request as-is.
	// Rewriting/cloning upgrade requests can break WebSocket upgrades in local dev.
	return stub.fetch(c.req.raw);
});

// ============================================
// Sharing Routes
// ============================================

/**
 * Share a column with another account
 */
app.post("/api/column/:id/share", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");
	const { targetAccountId } = await c.req.json<{ targetAccountId: string }>();

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (!validateAccountId(targetAccountId)) {
		return c.json({ error: "Invalid target account ID" }, 400);
	}

	// Check target account exists
	const normalizedTargetId = normalizeAccountId(targetAccountId);
	const targetData = await c.env.ACCOUNTS.get(`account:${normalizedTargetId}`);
	if (!targetData) {
		return c.json({ error: "Target account not found" }, 404);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Only owner can share
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can share" }, 403);
	}

	// Add to sharedWith
	const formattedTargetId = displayAccountId(targetAccountId);
	if (!meta.sharedWith.includes(formattedTargetId)) {
		meta.sharedWith.push(formattedTargetId);

		await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({ sharedWith: meta.sharedWith }),
			}),
		);

		// Add to target's shared columns list
		const sharedColumnsData = await c.env.ACCOUNTS.get(
			`shared:${normalizedTargetId}`,
		);
		const sharedColumns: string[] = sharedColumnsData
			? JSON.parse(sharedColumnsData)
			: [];

		if (!sharedColumns.includes(columnId)) {
			sharedColumns.push(columnId);
			await c.env.ACCOUNTS.put(
				`shared:${normalizedTargetId}`,
				JSON.stringify(sharedColumns),
			);
		}
	}

	return c.json({ success: true, sharedWith: meta.sharedWith });
});

/**
 * Revoke sharing for a column
 */
app.delete("/api/column/:id/share/:targetId", async (c) => {
	const columnId = c.req.param("id");
	const targetAccountId = c.req.param("targetId");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Only owner can revoke
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can revoke sharing" }, 403);
	}

	// Remove from sharedWith
	const normalizedTargetId = normalizeAccountId(targetAccountId);
	meta.sharedWith = meta.sharedWith.filter(
		(id) => normalizeAccountId(id) !== normalizedTargetId,
	);

	await stub.fetch(
		new Request("http://do/share", {
			method: "PUT",
			body: JSON.stringify({ sharedWith: meta.sharedWith }),
		}),
	);

	// Remove from target's shared columns list
	const sharedColumnsData = await c.env.ACCOUNTS.get(
		`shared:${normalizedTargetId}`,
	);
	if (sharedColumnsData) {
		const sharedColumns = JSON.parse(sharedColumnsData) as string[];
		const updated = sharedColumns.filter((id) => id !== columnId);
		await c.env.ACCOUNTS.put(
			`shared:${normalizedTargetId}`,
			JSON.stringify(updated),
		);
	}

	return c.json({ success: true, sharedWith: meta.sharedWith });
});

// ============================================
// Public Link Routes
// ============================================

/**
 * Enable public link for a column
 */
app.post("/api/column/:id/public", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Only owner can enable public link
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can enable public link" }, 403);
	}

	const publicId = generatePublicId();

	await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId }),
		}),
	);

	// Store reverse lookup
	await c.env.ACCOUNTS.put(`public:${publicId}`, columnId);

	const url = new URL(c.req.url);
	const publicUrl = `${url.origin}/p/${publicId}`;

	return c.json({ publicId, url: publicUrl });
});

/**
 * Disable public link for a column
 */
app.delete("/api/column/:id/public", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Only owner can disable public link
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can disable public link" }, 403);
	}

	// Delete reverse lookup
	if (meta.publicId) {
		await c.env.ACCOUNTS.delete(`public:${meta.publicId}`);
	}

	await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId: null }),
		}),
	);

	return c.json({ success: true });
});

/**
 * Get public column metadata
 */
app.get("/api/p/:publicId", async (c) => {
	const publicId = c.req.param("publicId");

	if (!shouldSkipRateLimit(c)) {
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			resourceRateLimitKey("public-view", publicId),
			RATE_LIMITS.publicView,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const columnId = await c.env.ACCOUNTS.get(`public:${publicId}`);
	if (!columnId) {
		return c.json({ error: "Public link not found" }, 404);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const meta = (await metaResponse.json()) as ColumnMeta;

	// Verify public link is still valid
	if (meta.publicId !== publicId) {
		return c.json({ error: "Public link not found" }, 404);
	}

	return c.json({ column: meta, columnId });
});

/**
 * WebSocket connection for public column view
 */
app.get("/api/p/:publicId/ws", async (c) => {
	const publicId = c.req.param("publicId");

	const columnId = await c.env.ACCOUNTS.get(`public:${publicId}`);
	if (!columnId) {
		return c.json({ error: "Public link not found" }, 404);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	// Forward the original upgrade request as-is so the DO can route by pathname.
	return stub.fetch(c.req.raw);
});

// Keep the clock endpoint for testing
app.get("/api/clock", (c) => {
	return c.json({
		time: new Date().toLocaleTimeString(),
	});
});

export type AppType = typeof app;

export default app;
