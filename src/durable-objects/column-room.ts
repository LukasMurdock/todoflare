import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import {
	encodeStateAsUpdate,
	encodeStateVector,
	applyUpdate,
	diffUpdate,
} from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { ColumnMeta, PresenceUser, SyncMessage } from "../types/account";
import { getAccountColor, normalizeAccountId } from "../lib/account";

/**
 * ColumnRoom Durable Object
 *
 * Handles real-time sync for a single column using Yjs CRDT.
 * Manages WebSocket connections, presence, and authorization.
 */
class ColumnRoom extends DurableObject<unknown> {
	private sessions: Map<WebSocket, SessionInfo> = new Map();
	private doc: Y.Doc;
	private awareness: awarenessProtocol.Awareness | null = null;
	private meta: ColumnMeta | null = null;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.doc = new Y.Doc();
		// Note: Awareness is lazily initialized on first WebSocket connection
		// to avoid setInterval issues in Cloudflare Workers DO runtime

		// Load persisted state
		this.ctx.blockConcurrencyWhile(async () => {
			await this.loadState();
		});
	}

	/**
	 * Get or create the awareness instance (lazy initialization)
	 */
	private getAwareness(): awarenessProtocol.Awareness {
		if (!this.awareness) {
			this.awareness = new awarenessProtocol.Awareness(this.doc);
			this.awareness.on("update", this.broadcastAwareness.bind(this));
		}
		return this.awareness;
	}

	/**
	 * Destroy awareness when no clients are connected to stop the interval timer
	 */
	private destroyAwareness(): void {
		if (this.awareness) {
			this.awareness.destroy();
			this.awareness = null;
		}
	}

	private async loadState() {
		// Load column metadata
		const metaData = await this.ctx.storage.get<ColumnMeta>("meta");
		if (metaData) {
			this.meta = metaData;
		}

		// Load Yjs document state
		const yjsState = await this.ctx.storage.get("yjs");
		if (yjsState) {
			try {
				// Handle various possible storage formats
				let update: Uint8Array;
				if (yjsState instanceof Uint8Array) {
					update = yjsState;
				} else if (yjsState instanceof ArrayBuffer) {
					update = new Uint8Array(yjsState);
				} else if (Array.isArray(yjsState)) {
					update = new Uint8Array(yjsState);
				} else if (
					typeof yjsState === "object" &&
					yjsState !== null
				) {
					// Handle object with numeric keys (serialized Uint8Array)
					const values = Object.values(yjsState as Record<string, number>);
					update = new Uint8Array(values);
				} else {
					console.error("Unexpected yjs state format:", typeof yjsState);
					return;
				}
				applyUpdate(this.doc, update);
			} catch (err) {
				console.error("Failed to apply stored Yjs state:", err);
				// Don't crash - start with empty document
			}
		}
	}

	private async saveState() {
		const update = encodeStateAsUpdate(this.doc);
		// Store the underlying ArrayBuffer for reliable serialization
		await this.ctx.storage.put("yjs", update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength));
	}

	private async saveMeta() {
		if (this.meta) {
			await this.ctx.storage.put("meta", this.meta);
		}
	}

	/**
	 * Initialize a new column
	 */
	async initialize(meta: ColumnMeta): Promise<void> {
		this.meta = meta;
		await this.saveMeta();
	}

	/**
	 * Get column metadata
	 */
	async getMeta(): Promise<ColumnMeta | null> {
		return this.meta;
	}

	/**
	 * Update column metadata (sharing, public link)
	 */
	async updateMeta(
		updates: Partial<Pick<ColumnMeta, "sharedWith" | "publicId">>,
	): Promise<ColumnMeta | null> {
		if (!this.meta) return null;

		if (updates.sharedWith !== undefined) {
			this.meta.sharedWith = updates.sharedWith;
		}
		if (updates.publicId !== undefined) {
			this.meta.publicId = updates.publicId;
		}

		await this.saveMeta();
		return this.meta;
	}

	/**
	 * Check if an account has access to this column
	 */
	hasAccess(accountId: string | null, isPublic: boolean = false): boolean {
		if (!this.meta) return false;

		// Public access (read-only)
		if (isPublic && this.meta.publicId) {
			return true;
		}

		if (!accountId) return false;

		// Normalize IDs for comparison (handles spaces vs no spaces)
		const normalizedAccountId = normalizeAccountId(accountId);
		const normalizedOwnerId = normalizeAccountId(this.meta.ownerId);

		// Owner always has access
		if (normalizedOwnerId === normalizedAccountId) return true;

		// Check shared accounts (also normalize)
		return this.meta.sharedWith.some(
			(id) => normalizeAccountId(id) === normalizedAccountId,
		);
	}

	/**
	 * Check if an account can edit (not public viewers)
	 */
	canEdit(accountId: string | null): boolean {
		if (!this.meta || !accountId) return false;

		// Normalize IDs for comparison (handles spaces vs no spaces)
		const normalizedAccountId = normalizeAccountId(accountId);
		const normalizedOwnerId = normalizeAccountId(this.meta.ownerId);

		return (
			normalizedOwnerId === normalizedAccountId ||
			this.meta.sharedWith.some(
				(id) => normalizeAccountId(id) === normalizedAccountId,
			)
		);
	}

	/**
	 * Handle HTTP requests (for metadata operations)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// WebSocket upgrade
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocket(request);
		}

		// Get metadata
		if (request.method === "GET" && url.pathname === "/meta") {
			const meta = await this.getMeta();
			if (!meta) {
				return new Response("Column not found", { status: 404 });
			}
			return Response.json(meta);
		}

		// Export state for migration
		if (request.method === "GET" && url.pathname === "/export") {
			const meta = await this.getMeta();
			if (!meta) {
				return new Response("Column not found", { status: 404 });
			}

			const yjsState = await this.ctx.storage.get("yjs");
			const bytes = toUint8Array(yjsState);
			return Response.json({ meta, yjs: bytes ? Array.from(bytes) : null });
		}

		// Initialize column
		if (request.method === "POST" && url.pathname === "/init") {
			const meta = (await request.json()) as ColumnMeta;
			await this.initialize(meta);
			return Response.json({ success: true });
		}

		// Update sharing
		if (request.method === "PUT" && url.pathname === "/share") {
			const { sharedWith } = (await request.json()) as {
				sharedWith: string[];
			};
			const meta = await this.updateMeta({ sharedWith });
			if (!meta) {
				return new Response("Column not found", { status: 404 });
			}

			// Notify removed accounts
			this.notifyAccessChanges(sharedWith);

			return Response.json(meta);
		}

		// Update public link
		if (request.method === "PUT" && url.pathname === "/public") {
			const { publicId } = (await request.json()) as {
				publicId: string | null;
			};
			const meta = await this.updateMeta({ publicId });
			if (!meta) {
				return new Response("Column not found", { status: 404 });
			}
			return Response.json(meta);
		}

		// Delete column
		if (request.method === "DELETE" && url.pathname === "/") {
			// Notify all connected clients
			this.broadcastMessage({ type: "column-deleted" });
			// Close all connections
			for (const ws of this.sessions.keys()) {
				ws.close(1000, "Column deleted");
			}
			// Clear storage
			await this.ctx.storage.deleteAll();
			this.meta = null;
			return Response.json({ success: true });
		}

		return new Response("Not found", { status: 404 });
	}

	/**
	 * Handle WebSocket connection
	 */
	private handleWebSocket(request: Request): Response {
		const url = new URL(request.url);
		const accountId = url.searchParams.get("accountId");
		const isPublic = url.searchParams.get("public") === "true";
		const publicId = url.searchParams.get("publicId");

		// Validate access
		if (isPublic) {
			if (!this.meta?.publicId || this.meta.publicId !== publicId) {
				return new Response("Invalid public link", { status: 403 });
			}
		} else if (!this.hasAccess(accountId, false)) {
			return new Response("Access denied", { status: 403 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		const session: SessionInfo = {
			accountId,
			isPublic,
			readOnly: isPublic, // Public viewers are read-only
			connectedAt: Date.now(),
		};

		this.ctx.acceptWebSocket(server);
		this.sessions.set(server, session);

		// Send initial sync
		this.sendInitialSync(server);

		// Broadcast presence update
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Send initial Yjs state to new connection
	 */
	private sendInitialSync(ws: WebSocket) {
		// Send full document state
		const stateVector = encodeStateVector(this.doc);
		const update = encodeStateAsUpdate(this.doc);

		this.sendMessage(ws, {
			type: "sync",
			data: update,
		});

		// Send current awareness state
		const awareness = this.getAwareness();
		const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
			awareness,
			Array.from(awareness.getStates().keys()),
		);
		this.sendMessage(ws, {
			type: "awareness",
			data: awarenessUpdate,
		});

		// Send presence list
		this.sendPresence(ws);
	}

	/**
	 * Handle incoming WebSocket message
	 */
	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const session = this.sessions.get(ws);
		if (!session) return;

		try {
			if (typeof message === "string") {
				const parsed = JSON.parse(message) as SyncMessage;
				this.handleSyncMessage(ws, session, parsed);
			} else {
				// Binary message - assume it's a Yjs update
				const data = new Uint8Array(message);
				this.handleBinaryMessage(ws, session, data);
			}
		} catch (err) {
			console.error("Error handling message:", err);
		}
	}

	private handleSyncMessage(
		ws: WebSocket,
		session: SessionInfo,
		message: SyncMessage,
	) {
		switch (message.type) {
			case "sync":
				if (!session.readOnly) {
					this.applyUpdate(new Uint8Array(message.data), ws);
				}
				break;
			case "awareness":
				this.applyAwareness(new Uint8Array(message.data), ws);
				break;
		}
	}

	private handleBinaryMessage(
		ws: WebSocket,
		session: SessionInfo,
		data: Uint8Array,
	) {
		// Assume binary messages are Yjs updates
		if (!session.readOnly) {
			this.applyUpdate(data, ws);
		}
	}

	/**
	 * Apply Yjs update and broadcast to others
	 */
	private applyUpdate(update: Uint8Array, origin: WebSocket) {
		applyUpdate(this.doc, update, origin);

		// Persist state (don't drop writes on refresh)
		this.ctx.waitUntil(this.saveState());

		// Broadcast to other clients
		for (const [ws, session] of this.sessions) {
			if (ws !== origin && ws.readyState === WebSocket.OPEN) {
				this.sendMessage(ws, { type: "sync", data: update });
			}
		}
	}

	/**
	 * Apply awareness update and broadcast
	 */
	private applyAwareness(update: Uint8Array, origin: WebSocket) {
		awarenessProtocol.applyAwarenessUpdate(this.getAwareness(), update, origin);
	}

	/**
	 * Broadcast awareness to all clients
	 */
	private broadcastAwareness() {
		const awareness = this.awareness;
		if (!awareness) return;

		const update = awarenessProtocol.encodeAwarenessUpdate(
			awareness,
			Array.from(awareness.getStates().keys()),
		);

		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				this.sendMessage(ws, { type: "awareness", data: update });
			}
		}
	}

	/**
	 * Handle WebSocket close
	 */
	webSocketClose(ws: WebSocket) {
		const session = this.sessions.get(ws);
		if (session) {
			this.sessions.delete(ws);
			this.broadcastPresence();

			// Destroy awareness when no clients are connected to stop the interval timer
			if (this.sessions.size === 0) {
				this.destroyAwareness();
			}
		}
	}

	/**
	 * Handle WebSocket error
	 */
	webSocketError(ws: WebSocket) {
		this.webSocketClose(ws);
	}

	/**
	 * Get list of presence users
	 */
	private getPresenceUsers(): PresenceUser[] {
		const users: PresenceUser[] = [];
		const seenAccounts = new Set<string>();

		for (const [, session] of this.sessions) {
			// Don't show public viewers in presence
			if (session.isPublic || !session.accountId) continue;

			// Deduplicate by account ID
			if (seenAccounts.has(session.accountId)) continue;
			seenAccounts.add(session.accountId);

			users.push({
				accountId: session.accountId,
				color: getAccountColor(session.accountId),
				connectedAt: session.connectedAt,
			});
		}

		return users;
	}

	/**
	 * Send presence to a specific client
	 */
	private sendPresence(ws: WebSocket) {
		const users = this.getPresenceUsers();
		this.sendMessage(ws, { type: "presence", users });
	}

	/**
	 * Broadcast presence to all clients
	 */
	private broadcastPresence() {
		const users = this.getPresenceUsers();
		this.broadcastMessage({ type: "presence", users });
	}

	/**
	 * Notify clients about access changes (revoked shares)
	 */
	private notifyAccessChanges(newSharedWith: string[]) {
		const newSet = new Set(newSharedWith);

		for (const [ws, session] of this.sessions) {
			if (
				session.accountId &&
				!session.isPublic &&
				session.accountId !== this.meta?.ownerId &&
				!newSet.has(session.accountId)
			) {
				// Access was revoked
				this.sendMessage(ws, { type: "access-revoked" });
				ws.close(1000, "Access revoked");
			}
		}
	}

	/**
	 * Send message to a specific WebSocket
	 */
	private sendMessage(ws: WebSocket, message: SyncMessage) {
		if (ws.readyState === WebSocket.OPEN) {
			if (message.type === "sync" || message.type === "awareness") {
				// Send binary data as ArrayBuffer
				ws.send(
					JSON.stringify({
						type: message.type,
						data: Array.from(message.data),
					}),
				);
			} else {
				ws.send(JSON.stringify(message));
			}
		}
	}

	/**
	 * Broadcast message to all connected clients
	 */
	private broadcastMessage(message: SyncMessage) {
		for (const [ws] of this.sessions) {
			this.sendMessage(ws, message);
		}
	}
}

const WS_OP_SYNC = 0x01;
const WS_OP_AWARENESS = 0x02;
const WS_OP_PRESENCE = 0x03;
const WS_OP_COLUMN_DELETED = 0x04;
const WS_OP_ACCESS_REVOKED = 0x05;
const WS_OP_ERROR = 0x06;

const DO_PERSIST_SCHEMA_VERSION = 1;
const DO_MIGRATION_TAG = "column-room-sql-v1";

const wsTextEncoder = new TextEncoder();
const wsTextDecoder = new TextDecoder();

function encodeWsFrame(op: number, payload?: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(1 + (payload?.byteLength ?? 0));
	out[0] = op;
	if (payload && payload.byteLength > 0) {
		out.set(payload, 1);
	}
	return out.buffer;
}

function encodeWsJsonFrame(op: number, value: unknown): ArrayBuffer {
	return encodeWsFrame(op, wsTextEncoder.encode(JSON.stringify(value)));
}

function encodeWsTextFrame(op: number, value: string): ArrayBuffer {
	return encodeWsFrame(op, wsTextEncoder.encode(value));
}

function decodeWsFrame(message: ArrayBuffer): { op: number; payload: Uint8Array } {
	const data = new Uint8Array(message);
	return { op: data[0] ?? 0, payload: data.subarray(1) };
}

function toUint8Array(value: unknown): Uint8Array | null {
	if (!value) return null;
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return new Uint8Array(value);
	if (typeof value === "object") {
		const values = Object.values(value as Record<string, number>);
		return new Uint8Array(values);
	}
	return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// Ensure we always hand SQLite a real ArrayBuffer (not SharedArrayBuffer).
	return bytes.slice().buffer;
}

export class ColumnRoomSql extends DurableObject<unknown> {
	private sessions: Map<WebSocket, SessionInfo> = new Map();
	private awarenessClientsBySocket: Map<WebSocket, Set<number>> = new Map();
	private doc: Y.Doc;
	private awareness: awarenessProtocol.Awareness | null = null;
	private meta: ColumnMeta | null = null;
	private nextCompactionAlarmAt = 0;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.doc = new Y.Doc();

		this.ctx.blockConcurrencyWhile(async () => {
			this.setupSchema();
			this.loadStateFromSql();
			this.restoreHibernatedWebSockets();
		});
	}

	private setupSchema() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				meta TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS yjs_snapshot (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				snapshot BLOB NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS yjs_updates (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				update_blob BLOB NOT NULL,
				ts INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_yjs_updates_ts ON yjs_updates(ts);

			CREATE TABLE IF NOT EXISTS storage_migrations (
				migration_tag TEXT PRIMARY KEY,
				applied_at INTEGER NOT NULL
			);
		`);

		this.addColumnIfMissing(
			"meta",
			"schema_version INTEGER NOT NULL DEFAULT 1",
		);
		this.addColumnIfMissing(
			"meta",
			"migration_tag TEXT NOT NULL DEFAULT 'column-room-sql-v1'",
		);

		this.addColumnIfMissing(
			"yjs_snapshot",
			"schema_version INTEGER NOT NULL DEFAULT 1",
		);
		this.addColumnIfMissing(
			"yjs_snapshot",
			"migration_tag TEXT NOT NULL DEFAULT 'column-room-sql-v1'",
		);

		this.addColumnIfMissing(
			"yjs_updates",
			"schema_version INTEGER NOT NULL DEFAULT 1",
		);
		this.addColumnIfMissing(
			"yjs_updates",
			"migration_tag TEXT NOT NULL DEFAULT 'column-room-sql-v1'",
		);

		this.ctx.storage.sql.exec(
			"INSERT INTO storage_migrations (migration_tag, applied_at) VALUES (?, ?) ON CONFLICT(migration_tag) DO NOTHING",
			DO_MIGRATION_TAG,
			Date.now(),
		);
	}

	private addColumnIfMissing(table: string, columnDefinition: string) {
		try {
			this.ctx.storage.sql.exec(
				`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`,
			);
		} catch {
			// Column already exists.
		}
	}

	private loadStateFromSql() {
		const metaRow = this.ctx.storage.sql
			.exec<{ meta: string; schema_version: number; migration_tag: string }>(
				"SELECT meta, schema_version, migration_tag FROM meta WHERE id = 1",
			)
			.toArray()[0];
		if (metaRow?.meta) {
			try {
				const parsed = JSON.parse(metaRow.meta) as
					| ColumnMeta
					| {
							schemaVersion: number;
							migrationTag: string;
							meta: ColumnMeta;
					  };

				if (
					parsed &&
					typeof parsed === "object" &&
					"meta" in parsed &&
					parsed.meta
				) {
					this.meta = parsed.meta;
				} else {
					this.meta = parsed as ColumnMeta;
				}
			} catch (err) {
				console.error("Failed to parse stored meta:", err);
			}
		}

		const snapshotRow = this.ctx.storage.sql
			.exec<{
				snapshot: ArrayBuffer;
				schema_version: number;
				migration_tag: string;
			}>(
				"SELECT snapshot, schema_version, migration_tag FROM yjs_snapshot WHERE id = 1",
			)
			.toArray()[0];
		if (snapshotRow?.snapshot) {
			try {
				applyUpdate(this.doc, toUint8Array(snapshotRow.snapshot) ?? new Uint8Array());
			} catch (err) {
				console.error("Failed to apply snapshot:", err);
			}
		}

		const updates = this.ctx.storage.sql
			.exec<{ update_blob: ArrayBuffer }>(
				"SELECT update_blob FROM yjs_updates ORDER BY seq ASC",
			)
			.toArray();
		for (const row of updates) {
			const bytes = toUint8Array(row.update_blob);
			if (!bytes) continue;
			try {
				applyUpdate(this.doc, bytes);
			} catch (err) {
				console.error("Failed to apply queued update:", err);
			}
		}
	}

	private restoreHibernatedWebSockets() {
		try {
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment();
				if (attachment) {
					this.sessions.set(ws, attachment as SessionInfo);
				}
			}

			if (this.sessions.size > 0) {
				this.getAwareness();
				this.broadcastPresence();
			}
		} catch (err) {
			console.error("Failed to restore hibernated sockets:", err);
		}
	}

	private getAwareness(): awarenessProtocol.Awareness {
		if (!this.awareness) {
			this.awareness = new awarenessProtocol.Awareness(this.doc);
			this.awareness.on("update", this.handleAwarenessUpdate.bind(this));
		}
		return this.awareness;
	}

	private destroyAwareness(): void {
		if (this.awareness) {
			this.awareness.destroy();
			this.awareness = null;
		}
		this.awarenessClientsBySocket.clear();
	}

	private handleAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		const awareness = this.awareness;
		if (!awareness) return;

		if (origin instanceof WebSocket && this.sessions.has(origin)) {
			const known = this.awarenessClientsBySocket.get(origin) ?? new Set<number>();

			for (const clientId of [...added, ...updated]) {
				if (awareness.getStates().has(clientId)) {
					known.add(clientId);
				}
			}

			for (const clientId of removed) {
				known.delete(clientId);
			}

			if (known.size > 0) {
				this.awarenessClientsBySocket.set(origin, known);
			} else {
				this.awarenessClientsBySocket.delete(origin);
			}
		}

		this.broadcastAwareness();
	}

	private persistMeta() {
		if (!this.meta) return;
		const envelope = {
			schemaVersion: DO_PERSIST_SCHEMA_VERSION,
			migrationTag: DO_MIGRATION_TAG,
			meta: this.meta,
		};
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (id, meta, schema_version, migration_tag) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, schema_version = excluded.schema_version, migration_tag = excluded.migration_tag",
			JSON.stringify(envelope),
			DO_PERSIST_SCHEMA_VERSION,
			DO_MIGRATION_TAG,
		);
	}

	private insertUpdate(update: Uint8Array) {
		this.ctx.storage.sql.exec(
			"INSERT INTO yjs_updates (update_blob, ts, schema_version, migration_tag) VALUES (?, ?, ?, ?)",
			toArrayBuffer(update),
			Date.now(),
			DO_PERSIST_SCHEMA_VERSION,
			DO_MIGRATION_TAG,
		);
		this.scheduleCompaction();
	}

	private persistSnapshot() {
		const snapshot = encodeStateAsUpdate(this.doc);
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO yjs_snapshot (id, snapshot, updated_at, schema_version, migration_tag) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at, schema_version = excluded.schema_version, migration_tag = excluded.migration_tag;",
			toArrayBuffer(snapshot),
			now,
			DO_PERSIST_SCHEMA_VERSION,
			DO_MIGRATION_TAG,
		);
	}

	private scheduleCompaction() {
		const target = Date.now() + 10_000;
		if (target <= this.nextCompactionAlarmAt) return;
		this.nextCompactionAlarmAt = target;
		this.ctx.waitUntil(this.ctx.storage.setAlarm(target));
	}

	async alarm() {
		try {
			this.persistSnapshot();
			this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
		} catch (err) {
			console.error("Compaction failed:", err);
		}
	}

	private hasAccess(accountId: string | null, isPublic: boolean): boolean {
		if (!this.meta) return false;
		if (isPublic && this.meta.publicId) return true;
		if (!accountId) return false;

		const normalizedAccountId = normalizeAccountId(accountId);
		const normalizedOwnerId = normalizeAccountId(this.meta.ownerId);
		if (normalizedOwnerId === normalizedAccountId) return true;
		return this.meta.sharedWith.some(
			(id) => normalizeAccountId(id) === normalizedAccountId,
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocket(request);
		}

		if (request.method === "GET" && url.pathname === "/meta") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			return Response.json(this.meta);
		}

		if (request.method === "GET" && url.pathname === "/export") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			const snapshot = encodeStateAsUpdate(this.doc);
			return Response.json({
				meta: this.meta,
				yjs: snapshot.length > 0 ? Array.from(snapshot) : null,
			});
		}

		if (request.method === "POST" && url.pathname === "/init") {
			const meta = (await request.json()) as ColumnMeta;
			this.meta = meta;
			this.persistMeta();
			return Response.json({ success: true });
		}

		if (request.method === "POST" && url.pathname === "/import") {
			const body = (await request.json()) as { meta: ColumnMeta; yjs: number[] | null };

			this.meta = body.meta;
			this.persistMeta();

			this.doc = new Y.Doc();
			this.destroyAwareness();
			if (body.yjs && body.yjs.length > 0) {
				try {
					applyUpdate(this.doc, new Uint8Array(body.yjs));
				} catch (err) {
					console.error("Failed to apply imported Yjs state:", err);
				}
			}
			this.persistSnapshot();
			this.ctx.storage.sql.exec("DELETE FROM yjs_updates");

			return Response.json({ success: true });
		}

		if (request.method === "PUT" && url.pathname === "/share") {
			const { sharedWith } = (await request.json()) as { sharedWith: string[] };
			if (!this.meta) return new Response("Column not found", { status: 404 });
			this.meta.sharedWith = sharedWith;
			this.persistMeta();
			this.notifyAccessChanges(sharedWith);
			return Response.json(this.meta);
		}

		if (request.method === "PUT" && url.pathname === "/public") {
			const { publicId } = (await request.json()) as { publicId: string | null };
			if (!this.meta) return new Response("Column not found", { status: 404 });
			this.meta.publicId = publicId;
			this.persistMeta();
			return Response.json(this.meta);
		}

		if (request.method === "DELETE" && url.pathname === "/") {
			this.broadcastBinary(WS_OP_COLUMN_DELETED);
			for (const ws of this.sessions.keys()) {
				ws.close(1000, "Column deleted");
			}
			await this.ctx.storage.deleteAll();
			this.meta = null;
			this.sessions.clear();
			this.destroyAwareness();
			this.doc = new Y.Doc();
			return Response.json({ success: true });
		}

		return new Response("Not found", { status: 404 });
	}

	private handleWebSocket(request: Request): Response {
		const url = new URL(request.url);
		const accountId = url.searchParams.get("accountId");

		// Public websockets are routed via `/api/p/:publicId/ws`.
		// Keep query-param support as a fallback for older clients.
		let isPublic = url.searchParams.get("public") === "true";
		let publicId = url.searchParams.get("publicId");

		const parts = url.pathname.split("/").filter(Boolean);
		// Expected shape: ["api", "p", ":publicId", "ws"]
		if (parts[0] === "api" && parts[1] === "p" && parts[3] === "ws") {
			isPublic = true;
			publicId = publicId ?? parts[2] ?? null;
		}

		if (isPublic) {
			if (!this.meta?.publicId || this.meta.publicId !== publicId) {
				return new Response("Invalid public link", { status: 403 });
			}
		} else if (!this.hasAccess(accountId, false)) {
			return new Response("Access denied", { status: 403 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		const session: SessionInfo = {
			accountId,
			isPublic,
			readOnly: isPublic,
			connectedAt: Date.now(),
		};

		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(session);
		this.sessions.set(server, session);

		this.sendInitialSync(server);
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	private sendInitialSync(ws: WebSocket) {
		const update = encodeStateAsUpdate(this.doc);
		ws.send(encodeWsFrame(WS_OP_SYNC, update));

		const awareness = this.getAwareness();
		const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
			awareness,
			Array.from(awareness.getStates().keys()),
		);
		ws.send(encodeWsFrame(WS_OP_AWARENESS, awarenessUpdate));

		this.sendPresence(ws);
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		let session = this.sessions.get(ws);
		if (!session) {
			const attachment = ws.deserializeAttachment();
			if (attachment) {
				session = attachment as SessionInfo;
				this.sessions.set(ws, session);
			}
		}
		if (!session) return;

		if (typeof message === "string") {
			ws.send(encodeWsTextFrame(WS_OP_ERROR, "Binary WebSocket required"));
			ws.close(1003, "Binary WebSocket required");
			return;
		}

		try {
			const { op, payload } = decodeWsFrame(message);
			switch (op) {
				case WS_OP_SYNC:
					if (!session.readOnly) {
						this.applyUpdate(payload, ws);
					}
					break;
				case WS_OP_AWARENESS:
					if (!session.isPublic) {
						this.applyAwareness(payload, ws);
					}
					break;
				default:
					ws.send(encodeWsTextFrame(WS_OP_ERROR, `Unknown opcode: ${op}`));
			}
		} catch (err) {
			console.error("Error handling binary message:", err);
		}
	}

	private applyUpdate(update: Uint8Array, origin: WebSocket) {
		applyUpdate(this.doc, update, origin);
		this.insertUpdate(update);

		for (const [ws] of this.sessions) {
			if (ws !== origin && ws.readyState === WebSocket.OPEN) {
				ws.send(encodeWsFrame(WS_OP_SYNC, update));
			}
		}
	}

	private applyAwareness(update: Uint8Array, origin: WebSocket) {
		awarenessProtocol.applyAwarenessUpdate(this.getAwareness(), update, origin);
	}

	private broadcastAwareness() {
		const awareness = this.awareness;
		if (!awareness) return;

		const update = awarenessProtocol.encodeAwarenessUpdate(
			awareness,
			Array.from(awareness.getStates().keys()),
		);

		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(encodeWsFrame(WS_OP_AWARENESS, update));
			}
		}
	}

	webSocketClose(ws: WebSocket) {
		const awareness = this.awareness;
		const clientIds = this.awarenessClientsBySocket.get(ws);
		if (awareness && clientIds && clientIds.size > 0) {
			awarenessProtocol.removeAwarenessStates(
				awareness,
				Array.from(clientIds),
				ws,
			);
		}

		this.awarenessClientsBySocket.delete(ws);

		const session = this.sessions.get(ws);
		if (!session) return;
		this.sessions.delete(ws);
		this.broadcastPresence();
		if (this.sessions.size === 0) {
			this.destroyAwareness();
		}
	}

	webSocketError(ws: WebSocket) {
		this.webSocketClose(ws);
	}

	private getPresenceUsers(): PresenceUser[] {
		const users: PresenceUser[] = [];
		const seenAccounts = new Set<string>();

		for (const [, session] of this.sessions) {
			if (session.isPublic || !session.accountId) continue;
			if (seenAccounts.has(session.accountId)) continue;
			seenAccounts.add(session.accountId);
			users.push({
				accountId: session.accountId,
				color: getAccountColor(session.accountId),
				connectedAt: session.connectedAt,
			});
		}

		return users;
	}

	private sendPresence(ws: WebSocket) {
		const users = this.getPresenceUsers();
		ws.send(encodeWsJsonFrame(WS_OP_PRESENCE, { users }));
	}

	private broadcastPresence() {
		const users = this.getPresenceUsers();
		this.broadcastBinary(
			WS_OP_PRESENCE,
			wsTextEncoder.encode(JSON.stringify({ users })),
		);
	}

	private notifyAccessChanges(newSharedWith: string[]) {
		const newSet = new Set(newSharedWith);

		for (const [ws, session] of this.sessions) {
			if (
				session.accountId &&
				!session.isPublic &&
				session.accountId !== this.meta?.ownerId &&
				!newSet.has(session.accountId)
			) {
				ws.send(encodeWsFrame(WS_OP_ACCESS_REVOKED));
				ws.close(1000, "Access revoked");
			}
		}
	}

	private broadcastBinary(op: number, payload?: Uint8Array) {
		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(encodeWsFrame(op, payload));
			}
		}
	}
}

interface SessionInfo {
	accountId: string | null;
	isPublic: boolean;
	readOnly: boolean;
	connectedAt: number;
}
