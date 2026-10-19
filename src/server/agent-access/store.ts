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
			};
			const token = randomId(TOKEN_PREFIX, 32);
			await db.batch([
				db
					.prepare(
						`INSERT INTO "agent_connection" ("id", "userId", "name", "createdAt", "expiresAt")
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.bind(row.id, row.userId, row.name, row.createdAt, row.expiresAt),
				db
					.prepare(
						`INSERT INTO "agent_token" ("tokenHash", "connectionId", "kind", "createdAt", "expiresAt")
						 VALUES (?, ?, 'personal', ?, ?)`,
					)
					.bind(await agentTokenHash(token), row.id, row.createdAt, row.expiresAt),
			]);
			return { ok: true, value: { agent: toConnection(row, []), token } };
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
					 WHERE t."tokenHash" = ? AND t."expiresAt" > ? AND c."revokedAt" IS NULL AND c."expiresAt" > ?`,
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
