import {
	AGENT_CONNECTIONS_PER_ACCOUNT,
	AGENT_GRANTS_PER_CONNECTION,
	type AgentConnection,
	type AgentGrant,
	type AgentGrantLevel,
} from "../../lib/api/agent-contract";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "tfa_";
const TOKEN_PATTERN = /^tfa_[A-Za-z0-9_-]{43}$/;
/** Refresh tokens look different, so they can never be mistaken for access tokens. */
const REFRESH_PREFIX = "tfr_";
const REFRESH_PATTERN = /^tfr_[A-Za-z0-9_-]{43}$/;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId(prefix: string, bytes: number): string {
	return prefix + base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function agentTokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return base64Url(new Uint8Array(digest));
}

interface ConnectionRow {
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	expiresAt: number;
	revokedAt: number | null;
	lastUsedAt: number | null;
	clientId: string | null;
}

interface GrantRow {
	connectionId: string;
	columnId: string;
	level: AgentGrantLevel;
	createdAt: number;
	updatedAt: number;
	expiresAt: number | null;
}

export type ResolvedAgent = Pick<ConnectionRow, "id" | "userId" | "name" | "expiresAt" | "revokedAt">;

export interface IssuedTokens {
	accessToken: string;
	refreshToken: string;
	/** Seconds, as OAuth reports it. */
	expiresIn: number;
}

function toGrant(row: GrantRow): AgentGrant {
	return {
		columnId: row.columnId,
		level: row.level,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		expiresAt: row.expiresAt,
	};
}

function toConnection(row: ConnectionRow, grants: GrantRow[]): AgentConnection {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		lastUsedAt: row.lastUsedAt,
		clientId: row.clientId ?? null,
		grants: grants.map(toGrant),
	};
}

export type AgentStoreFailure = "not_found" | "limit_reached";
export type AgentStoreResult<T> = { ok: true; value: T } | { ok: false; reason: AgentStoreFailure };

/** Agent connections, their bearer tokens and their column grants, in D1. */
export function agentStore(db: D1Database) {
	async function grantsFor(connectionIds: string[]): Promise<Map<string, GrantRow[]>> {
		const byConnection = new Map<string, GrantRow[]>(connectionIds.map((id) => [id, []]));
		if (connectionIds.length === 0) return byConnection;
		const placeholders = connectionIds.map(() => "?").join(", ");
		const { results } = await db
			.prepare(`SELECT * FROM "agent_grant" WHERE "connectionId" IN (${placeholders}) ORDER BY "createdAt", "columnId"`)
			.bind(...connectionIds)
			.all<GrantRow>();
		for (const row of results) byConnection.get(row.connectionId)?.push(row);
		return byConnection;
	}

	/** The connection only if it belongs to this account and is still usable. */
	async function activeConnection(userId: string, connectionId: string, now: number): Promise<ConnectionRow | null> {
		return db
			.prepare(
				`SELECT * FROM "agent_connection"
				 WHERE "id" = ? AND "userId" = ? AND "revokedAt" IS NULL AND "expiresAt" > ?`,
			)
			.bind(connectionId, userId, now)
			.first<ConnectionRow>();
	}

	async function insertConnection(input: {
		userId: string;
		name: string;
		expiresInDays: number;
		clientId: string | null;
		now: number;
	}): Promise<AgentStoreResult<ConnectionRow>> {
		const active = await db
			.prepare(
				`SELECT COUNT(*) AS count FROM "agent_connection"
				 WHERE "userId" = ? AND "revokedAt" IS NULL AND "expiresAt" > ?`,
			)
			.bind(input.userId, input.now)
			.first<{ count: number }>();
		if ((active?.count ?? 0) >= AGENT_CONNECTIONS_PER_ACCOUNT) return { ok: false, reason: "limit_reached" };
		const row: ConnectionRow = {
			id: randomId("agt_", 16),
			userId: input.userId,
			name: input.name,
			createdAt: input.now,
			expiresAt: input.now + input.expiresInDays * DAY_MS,
			revokedAt: null,
			lastUsedAt: null,
			clientId: input.clientId,
		};
		await db
			.prepare(
				`INSERT INTO "agent_connection" ("id", "userId", "name", "createdAt", "expiresAt", "clientId")
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(row.id, row.userId, row.name, row.createdAt, row.expiresAt, row.clientId)
			.run();
		return { ok: true, value: row };
	}

	async function describe(row: ConnectionRow): Promise<AgentConnection> {
		return toConnection(row, (await grantsFor([row.id])).get(row.id) ?? []);
	}

	return {
		/** Live connections only: revoked and expired ones can never be used again. */
		async list(userId: string, now: number): Promise<AgentConnection[]> {
			const { results } = await db
				.prepare(
					`SELECT * FROM "agent_connection"
					 WHERE "userId" = ? AND "revokedAt" IS NULL AND "expiresAt" > ?
					 ORDER BY "createdAt", "id"`,
				)
				.bind(userId, now)
				.all<ConnectionRow>();
			const grants = await grantsFor(results.map((row) => row.id));
			return results.map((row) => toConnection(row, grants.get(row.id) ?? []));
		},

		/** Creates a connection with a personal bearer token valid for its whole lifetime. */
		async create(input: {
			userId: string;
			name: string;
			expiresInDays: number;
			now: number;
		}): Promise<AgentStoreResult<{ agent: AgentConnection; token: string }>> {
			const created = await insertConnection({ ...input, clientId: null });
			if (!created.ok) return created;
			const token = randomId(TOKEN_PREFIX, 32);
			await db
				.prepare(
					`INSERT INTO "agent_token" ("tokenHash", "connectionId", "kind", "createdAt", "expiresAt")
					 VALUES (?, ?, 'personal', ?, ?)`,
				)
				.bind(await agentTokenHash(token), created.value.id, input.now, created.value.expiresAt)
				.run();
			return { ok: true, value: { agent: toConnection(created.value, []), token } };
		},

		/** Creates a connection an OAuth client will obtain tokens for by redeeming a code. */
		async createForClient(input: {
			userId: string;
			name: string;
			expiresInDays: number;
			clientId: string;
			now: number;
		}): Promise<AgentStoreResult<{ id: string; expiresAt: number }>> {
			const created = await insertConnection(input);
			return created.ok ? { ok: true, value: { id: created.value.id, expiresAt: created.value.expiresAt } } : created;
		},

		/** Short-lived access plus a refresh token, neither outliving the connection. */
		async issueTokens(connectionId: string, connectionExpiresAt: number, now: number): Promise<IssuedTokens> {
			const accessToken = randomId(TOKEN_PREFIX, 32);
			const refreshToken = randomId(REFRESH_PREFIX, 32);
			const accessExpiresAt = Math.min(now + ACCESS_TOKEN_TTL_MS, connectionExpiresAt);
			const insert = `INSERT INTO "agent_token" ("tokenHash", "connectionId", "kind", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?)`;
			await db.batch([
				db.prepare(insert).bind(await agentTokenHash(accessToken), connectionId, "access", now, accessExpiresAt),
				db.prepare(insert).bind(await agentTokenHash(refreshToken), connectionId, "refresh", now, Math.min(now + REFRESH_TOKEN_TTL_MS, connectionExpiresAt)),
			]);
			return { accessToken, refreshToken, expiresIn: Math.max(Math.floor((accessExpiresAt - now) / 1000), 0) };
		},

		/**
		 * Consumes a refresh token (rotation: each works once) and returns its
		 * connection, if it is still live and was issued to this client.
		 */
		async redeemRefreshToken(token: string, clientId: string, now: number): Promise<{ id: string; expiresAt: number } | null> {
			if (!REFRESH_PATTERN.test(token)) return null;
			const consumed = await db
				.prepare(`DELETE FROM "agent_token" WHERE "tokenHash" = ? AND "kind" = 'refresh' AND "expiresAt" > ? RETURNING "connectionId"`)
				.bind(await agentTokenHash(token), now)
				.first<{ connectionId: string }>();
			if (!consumed) return null;
			const connection = await db
				.prepare(`SELECT "id", "expiresAt" FROM "agent_connection" WHERE "id" = ? AND "clientId" = ? AND "revokedAt" IS NULL AND "expiresAt" > ?`)
				.bind(consumed.connectionId, clientId, now)
				.first<{ id: string; expiresAt: number }>();
			return connection ?? null;
		},

		/** Revokes a connection on behalf of the system, e.g. after a replayed authorization code. */
		async revokeById(connectionId: string, now: number): Promise<void> {
			await db.batch([
				db.prepare(`UPDATE "agent_connection" SET "revokedAt" = ? WHERE "id" = ? AND "revokedAt" IS NULL`).bind(now, connectionId),
				db.prepare(`DELETE FROM "agent_token" WHERE "connectionId" = ?`).bind(connectionId),
				db.prepare(`DELETE FROM "agent_grant" WHERE "connectionId" = ?`).bind(connectionId),
			]);
		},

		/**
		 * Revocation deletes every token and grant in the same transaction as
		 * marking the connection, so no lookup can observe a half-revoked agent.
		 */
		async revoke(userId: string, connectionId: string, now: number): Promise<AgentStoreResult<null>> {
			const [marked] = await db.batch([
				db
					.prepare(`UPDATE "agent_connection" SET "revokedAt" = ? WHERE "id" = ? AND "userId" = ? AND "revokedAt" IS NULL`)
					.bind(now, connectionId, userId),
				db
					.prepare(
						`DELETE FROM "agent_token" WHERE "connectionId" IN
						 (SELECT "id" FROM "agent_connection" WHERE "id" = ? AND "userId" = ?)`,
					)
					.bind(connectionId, userId),
				db
					.prepare(
						`DELETE FROM "agent_grant" WHERE "connectionId" IN
						 (SELECT "id" FROM "agent_connection" WHERE "id" = ? AND "userId" = ?)`,
					)
					.bind(connectionId, userId),
			]);
			return marked.meta.changes > 0 ? { ok: true, value: null } : { ok: false, reason: "not_found" };
		},

		async setGrant(input: {
			userId: string;
			connectionId: string;
			columnId: string;
			level: AgentGrantLevel;
			expiresAt: number | null;
			now: number;
		}): Promise<AgentStoreResult<AgentConnection>> {
			const connection = await activeConnection(input.userId, input.connectionId, input.now);
			if (!connection) return { ok: false, reason: "not_found" };
			const existing = await db
				.prepare(`SELECT 1 AS present FROM "agent_grant" WHERE "connectionId" = ? AND "columnId" = ?`)
				.bind(input.connectionId, input.columnId)
				.first();
			if (!existing) {
				const count = await db
					.prepare(`SELECT COUNT(*) AS count FROM "agent_grant" WHERE "connectionId" = ?`)
					.bind(input.connectionId)
					.first<{ count: number }>();
				if ((count?.count ?? 0) >= AGENT_GRANTS_PER_CONNECTION) return { ok: false, reason: "limit_reached" };
			}
			await db
				.prepare(
					`INSERT INTO "agent_grant" ("connectionId", "columnId", "level", "createdAt", "updatedAt", "expiresAt")
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT ("connectionId", "columnId") DO UPDATE SET
					   "level" = excluded."level", "updatedAt" = excluded."updatedAt", "expiresAt" = excluded."expiresAt"`,
				)
				.bind(input.connectionId, input.columnId, input.level, input.now, input.now, input.expiresAt)
				.run();
			return { ok: true, value: await describe(connection) };
		},

		async removeGrant(input: {
			userId: string;
			connectionId: string;
			columnId: string;
			now: number;
		}): Promise<AgentStoreResult<AgentConnection>> {
			const connection = await activeConnection(input.userId, input.connectionId, input.now);
			if (!connection) return { ok: false, reason: "not_found" };
			await db
				.prepare(`DELETE FROM "agent_grant" WHERE "connectionId" = ? AND "columnId" = ?`)
				.bind(input.connectionId, input.columnId)
				.run();
			return { ok: true, value: await describe(connection) };
		},

		/**
		 * The connection a presented bearer token belongs to, or null when the
		 * token is malformed, unknown, expired or its connection is unusable.
		 */
		async resolveToken(token: string, now: number): Promise<ResolvedAgent | null> {
			if (!TOKEN_PATTERN.test(token)) return null;
			return db
				.prepare(
					`SELECT c."id", c."userId", c."name", c."expiresAt", c."revokedAt"
					 FROM "agent_token" t JOIN "agent_connection" c ON c."id" = t."connectionId"
					 WHERE t."tokenHash" = ? AND t."kind" IN ('personal', 'access') AND t."expiresAt" > ?
					   AND c."revokedAt" IS NULL AND c."expiresAt" > ?`,
				)
				.bind(await agentTokenHash(token), now, now)
				.first<ResolvedAgent>();
		},

		async grant(connectionId: string, columnId: string): Promise<AgentGrant | null> {
			const row = await db
				.prepare(`SELECT * FROM "agent_grant" WHERE "connectionId" = ? AND "columnId" = ?`)
				.bind(connectionId, columnId)
				.first<GrantRow>();
			return row ? toGrant(row) : null;
		},

		async grants(connectionId: string): Promise<AgentGrant[]> {
			return ((await grantsFor([connectionId])).get(connectionId) ?? []).map(toGrant);
		},

		/** Recorded at most once a minute per connection, to keep reads cheap. */
		async touch(connectionId: string, now: number): Promise<void> {
			await db
				.prepare(
					`UPDATE "agent_connection" SET "lastUsedAt" = ?
					 WHERE "id" = ? AND ("lastUsedAt" IS NULL OR "lastUsedAt" < ?)`,
				)
				.bind(now, connectionId, now - 60_000)
				.run();
		},
	};
}
