import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { encodeStateAsUpdate, applyUpdate } from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { ColumnMeta, PresenceUser } from "../types/account";
import { getAccountColor, normalizeAccountId } from "../lib/account";
import {
	hasColumnAccess,
	isColumnOwner,
	normalizeAccountIdSet,
} from "../lib/column-access";
import { parseColumnMetaRecord } from "../server/persistence-records";
import { columnSnapshotImportSchema } from "../server/column-backup-payload";
import {
	isReadOnlyMode,
	readOnlyModeResponse,
	readOnlyModeWebSocketMessage,
	type ReadOnlyModeEnv,
} from "../server/read-only-mode";
import {
	decodeDurableSyncSubmission,
	decodeWsFrame,
	encodeDurableSyncAck,
	encodeWsFrame,
	encodeWsJsonFrame,
	encodeWsTextFrame,
	WS_OP_ACCESS_REVOKED,
	WS_OP_AWARENESS,
	WS_OP_COLUMN_DELETED,
	WS_OP_ERROR,
	WS_OP_PRESENCE,
	WS_OP_SYNC,
	WS_OP_SYNC_SUBMIT,
} from "../lib/collaboration/websocket-protocol";

const DO_PERSIST_SCHEMA_VERSION = 1;
const DO_MIGRATION_TAG = "column-room-sql-v1";
const WS_TICKET_TTL_MS = 45_000;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ticketHash(ticket: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(ticket),
	);
	return base64Url(new Uint8Array(digest));
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

export class ColumnRoomSql extends DurableObject<ReadOnlyModeEnv> {
	private sessions: Map<WebSocket, SessionInfo> = new Map();
	private awarenessClientsBySocket: Map<WebSocket, Set<number>> = new Map();
	private doc: Y.Doc;
	private awareness: awarenessProtocol.Awareness | null = null;
	private meta: ColumnMeta | null = null;
	private nextCompactionAlarmAt = 0;

	constructor(ctx: DurableObjectState, env: ReadOnlyModeEnv) {
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

			CREATE TABLE IF NOT EXISTS ws_tickets (
				token_hash TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_ws_tickets_expiry ON ws_tickets(expires_at);

			CREATE TABLE IF NOT EXISTS storage_migrations (
				migration_tag TEXT PRIMARY KEY,
				applied_at INTEGER NOT NULL
			);
		`);
	}

	private loadStateFromSql() {
		const metaRow = this.ctx.storage.sql
			.exec<{ meta: string }>("SELECT meta FROM meta WHERE id = 1")
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

				const candidate = (
					parsed &&
					typeof parsed === "object" &&
					"meta" in parsed &&
					parsed.meta
				)
					? parsed.meta
					: parsed;
				const validated = parseColumnMetaRecord(candidate);
				if (validated.ok) {
					this.meta = validated.value;
				} else {
					console.error("Stored column metadata failed validation", validated);
				}
			} catch (err) {
				console.error("Failed to parse stored meta:", err);
			}
		}

		const snapshotRow = this.ctx.storage.sql
			.exec<{ snapshot: ArrayBuffer }>(
				"SELECT snapshot FROM yjs_snapshot WHERE id = 1",
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
					const session = attachment as SessionInfo;
					if (isReadOnlyMode(this.env) && !session.readOnly) {
						this.rejectWritableSocket(ws);
						continue;
					}
					this.sessions.set(ws, session);
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
		this.persistMetaValue(this.meta);
	}

	private persistMetaValue(meta: ColumnMeta) {
		const envelope = {
			schemaVersion: DO_PERSIST_SCHEMA_VERSION,
			migrationTag: DO_MIGRATION_TAG,
			meta,
		};
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (id, meta) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET meta = excluded.meta",
			JSON.stringify(envelope),
		);
	}

	private insertUpdate(update: Uint8Array) {
		this.ctx.storage.sql.exec(
			"INSERT INTO yjs_updates (update_blob, ts) VALUES (?, ?)",
			toArrayBuffer(update),
			Date.now(),
		);
		this.scheduleCompaction();
	}

	private persistSnapshot() {
		this.persistSnapshotBytes(encodeStateAsUpdate(this.doc));
	}

	private persistSnapshotBytes(snapshot: Uint8Array) {
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO yjs_snapshot (id, snapshot, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at;",
			toArrayBuffer(snapshot),
			now,
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

		return hasColumnAccess(this.meta, accountId);
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

		if (request.method === "POST" && url.pathname === "/ws-ticket") {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();

			const accountId = request.headers.get("X-Authenticated-Account-ID");
			if (!this.hasAccess(accountId, false)) {
				return new Response("Access denied", { status: 403 });
			}

			const bytes = new Uint8Array(32);
			crypto.getRandomValues(bytes);
			const ticket = base64Url(bytes);
			const expiresAt = Date.now() + WS_TICKET_TTL_MS;
			this.ctx.storage.sql.exec("DELETE FROM ws_tickets WHERE expires_at <= ?", Date.now());
			this.ctx.storage.sql.exec(
				"INSERT INTO ws_tickets (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
				await ticketHash(ticket),
				accountId,
				expiresAt,
			);
			return Response.json(
				{ ticket, expiresAt },
				{ headers: { "Cache-Control": "private, no-store" } },
			);
		}

		if (request.method === "POST" && url.pathname === "/init") {
			const parsedMeta = parseColumnMetaRecord(await request.json());
			if (!parsedMeta.ok) {
				return Response.json(parsedMeta, { status: 400 });
			}
			this.meta = parsedMeta.value;
			this.persistMeta();
			return Response.json({ success: true });
		}

		if (request.method === "POST" && url.pathname === "/import") {
			let input: unknown;
			try {
				input = await request.json();
			} catch {
				return Response.json({ error: "invalid_import_json" }, { status: 400 });
			}

			const parsed = columnSnapshotImportSchema.safeParse(input);
			if (!parsed.success) {
				return Response.json({ error: "invalid_import_payload" }, { status: 400 });
			}

			const candidateDoc = new Y.Doc();
			try {
				if (parsed.data.yjs !== null) {
					applyUpdate(candidateDoc, Uint8Array.from(parsed.data.yjs));
				}
			} catch (err) {
				candidateDoc.destroy();
				console.error("Failed to decode imported Yjs state:", err);
				return Response.json({ error: "invalid_yjs_update" }, { status: 422 });
			}

			const snapshot = encodeStateAsUpdate(candidateDoc);
			try {
				this.ctx.storage.transactionSync(() => {
					this.persistMetaValue(parsed.data.meta);
					this.persistSnapshotBytes(snapshot);
					this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
				});
			} catch (err) {
				candidateDoc.destroy();
				console.error("Failed to persist imported column state:", err);
				return Response.json({ error: "import_persist_failed" }, { status: 500 });
			}

			const previousDoc = this.doc;
			this.meta = parsed.data.meta;
			this.doc = candidateDoc;
			this.destroyAwareness();
			previousDoc.destroy();

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

	private async handleWebSocket(request: Request): Promise<Response> {
		const url = new URL(request.url);
		let accountId: string | null = null;

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
		} else {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();

			const ticket = url.searchParams.get("ticket");
			if (!ticket) return new Response("WebSocket ticket required", { status: 403 });
			const hash = await ticketHash(ticket);
			const row = this.ctx.storage.sql
				.exec<{ account_id: string; expires_at: number }>(
					"SELECT account_id, expires_at FROM ws_tickets WHERE token_hash = ?",
					hash,
				)
				.toArray()[0];
			this.ctx.storage.sql.exec("DELETE FROM ws_tickets WHERE token_hash = ?", hash);
			if (!row || row.expires_at <= Date.now()) {
				return new Response("Invalid or expired WebSocket ticket", { status: 403 });
			}
			accountId = row.account_id;
			if (!this.hasAccess(accountId, false)) {
				return new Response("Access denied", { status: 403 });
			}
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

	private rejectWritableSocket(ws: WebSocket) {
		const message = readOnlyModeWebSocketMessage();
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(encodeWsTextFrame(WS_OP_ERROR, message));
		}
		ws.close(1013, "Read-only mode");
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
				case WS_OP_SYNC_SUBMIT:
					if (!session.readOnly) {
						if (isReadOnlyMode(this.env)) {
							this.rejectWritableSocket(ws);
							break;
						}
						const submission = decodeDurableSyncSubmission(payload);
						if (!submission) {
							ws.send(
								encodeWsTextFrame(WS_OP_ERROR, "Malformed sync submission"),
							);
							break;
						}
						this.applyDurableUpdate(
							submission.update,
							submission.outboxId,
							ws,
						);
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

	private applyDurableUpdate(
		update: Uint8Array,
		outboxId: string,
		origin: WebSocket,
	) {
		if (isReadOnlyMode(this.env)) {
			this.rejectWritableSocket(origin);
			return;
		}

		applyUpdate(this.doc, update, origin);
		this.insertUpdate(update);
		origin.send(encodeDurableSyncAck(outboxId));

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
		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(encodeWsJsonFrame(WS_OP_PRESENCE, { users }));
			}
		}
	}

	private notifyAccessChanges(newSharedWith: string[]) {
		const newSet = normalizeAccountIdSet(newSharedWith);

		for (const [ws, session] of this.sessions) {
			if (
				session.accountId &&
				!session.isPublic &&
				(!this.meta || !isColumnOwner(this.meta, session.accountId)) &&
				!newSet.has(normalizeAccountId(session.accountId))
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
