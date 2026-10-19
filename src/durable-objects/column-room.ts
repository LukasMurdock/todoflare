import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { encodeStateAsUpdate, applyUpdate } from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { ColumnMeta, PresenceUser, SyncMessage } from "../types/account";
import { getAccountColor, normalizeAccountId } from "../lib/account";
import {
	hasColumnAccess,
	isColumnOwner,
	normalizeAccountIdSet,
} from "../lib/column-access";
import { TRASH_RETENTION_MS, parseColumnMetaRecord } from "../server/persistence-records";
import { columnSnapshotImportSchema } from "../server/column-backup-payload";
import { describeAgentChange } from "../server/agent-access/change-diff";
import { applyAgentEdit, currentItemFields, undoAgentChange, type AgentEdit, type FieldValues, type UndoRecord } from "../server/agent-access/column-edits";
import { agentLevelIncludes, type AgentGrantLevel } from "../lib/api/agent-contract";
import {
	isReadOnlyMode,
	readOnlyModeResponse,
	readOnlyModeWebSocketMessage,
	type ReadOnlyModeEnv,
} from "../server/read-only-mode";
import {
	decodeDurableSyncSubmission,
	decodeWsFrame,
	encodeServerMessage,
	WS_OP_AWARENESS,
	WS_OP_SYNC_SUBMIT,
	WS_PROTOCOL_V1,
	MAX_WS_FRAME_BYTES,
	isWsPayloadWithinLimit,
} from "../lib/collaboration/websocket-protocol";

const DO_PERSIST_SCHEMA_VERSION = 1;
const DO_MIGRATION_TAG = "column-room-sql-v1";
const WS_TICKET_TTL_MS = 45_000;
const RECEIVED_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIVED_OUTBOX_MAX_ROWS = 100_000;
const AGENT_CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AGENT_CHANGE_MAX_ROWS = 1000;
/** Transaction origin for every agent edit and undo applied in this object. */
const AGENT_ORIGIN = "todoflare-agent";

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

async function updateDigest(update: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", update.slice().buffer);
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
	private storageLoadError: string | null = null;

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
			CREATE TABLE IF NOT EXISTS column_lifecycle (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				trashed_at INTEGER
			);

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

			CREATE TABLE IF NOT EXISTS received_outbox (
				account_id TEXT NOT NULL,
				outbox_id TEXT NOT NULL,
				update_digest TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				PRIMARY KEY (account_id, outbox_id)
			);

			CREATE INDEX IF NOT EXISTS idx_received_outbox_received_at
				ON received_outbox(received_at);


			CREATE TABLE IF NOT EXISTS ws_tickets (
				token_hash TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_ws_tickets_expiry ON ws_tickets(expires_at);

			CREATE TABLE IF NOT EXISTS agent_changes (
				id TEXT PRIMARY KEY,
				connection_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				agent_name TEXT NOT NULL,
				tool TEXT NOT NULL,
				required_level TEXT NOT NULL,
				summary TEXT NOT NULL,
				item_ids TEXT NOT NULL,
				undo TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				undone_at INTEGER,
				undone_by TEXT,
				undo_result TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_agent_changes_created_at ON agent_changes(created_at);

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
					this.storageLoadError = "invalid_stored_metadata";
					console.error("Stored column metadata failed validation", validated);
				}
			} catch (err) {
				this.storageLoadError = "invalid_stored_metadata";
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
				this.storageLoadError = "invalid_stored_snapshot";
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
			if (!bytes) {
				this.storageLoadError = "invalid_stored_update";
				continue;
			}
			try {
				applyUpdate(this.doc, bytes);
			} catch (err) {
				this.storageLoadError = "invalid_stored_update";
				console.error("Failed to apply queued update:", err);
			}
		}
	}

	private restoreHibernatedWebSockets() {
		try {
			if (this.storageLoadError) {
				for (const ws of this.ctx.getWebSockets()) ws.close(1011, "Stored column requires recovery");
				return;
			}
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

	private insertUpdateRow(update: Uint8Array) {
		this.ctx.storage.sql.exec(
			"INSERT INTO yjs_updates (update_blob, ts) VALUES (?, ?)",
			toArrayBuffer(update),
			Date.now(),
		);
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
		if (this.storageLoadError) return;
		try {
			this.ctx.storage.transactionSync(() => {
				this.persistSnapshot();
				this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
				this.pruneReceivedOutbox();
				this.pruneAgentChanges();
			});
		} catch (err) {
			console.error("Compaction failed:", err);
		}
	}

	private pruneReceivedOutbox() {
		this.ctx.storage.sql.exec(
			"DELETE FROM received_outbox WHERE received_at < ?",
			Date.now() - RECEIVED_OUTBOX_RETENTION_MS,
		);

		const count =
			this.ctx.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM received_outbox",
				)
				.toArray()[0]?.count ?? 0;
		const overflow = count - RECEIVED_OUTBOX_MAX_ROWS;
		if (overflow <= 0) return;

		this.ctx.storage.sql.exec(
			`DELETE FROM received_outbox WHERE rowid IN (
				SELECT rowid FROM received_outbox
				ORDER BY received_at ASC
				LIMIT ?
			)`,
			overflow,
		);
	}

	private pruneAgentChanges() {
		this.ctx.storage.sql.exec("DELETE FROM agent_changes WHERE created_at < ?", Date.now() - AGENT_CHANGE_RETENTION_MS);
		this.ctx.storage.sql.exec(
			`DELETE FROM agent_changes WHERE id NOT IN (
				SELECT id FROM agent_changes ORDER BY created_at DESC, rowid DESC LIMIT ?
			)`,
			AGENT_CHANGE_MAX_ROWS,
		);
	}

	/**
	 * Computes an agent edit or undo on a scratch copy, persists the resulting
	 * update with its change record, and only then applies and broadcasts it.
	 * Runs without yielding, so no other event can interleave between the
	 * version check and the write; a failed write leaves memory untouched.
	 */
	private commitAgentWork<T>(
		compute: (scratch: Y.Doc) => T | null,
		persist: (result: T, update: Uint8Array) => void,
	): T | null {
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, encodeStateAsUpdate(this.doc));
		const stateBefore = Y.encodeStateVector(scratch);
		const result = compute(scratch);
		if (result === null) {
			scratch.destroy();
			return null;
		}
		const update = encodeStateAsUpdate(scratch, stateBefore);
		scratch.destroy();
		this.ctx.storage.transactionSync(() => {
			if (update.byteLength > 2) this.insertUpdateRow(update);
			persist(result, update);
		});
		if (update.byteLength > 2) {
			applyUpdate(this.doc, update, AGENT_ORIGIN);
			this.scheduleCompaction();
			this.broadcast({ type: "sync", data: update });
		}
		return result;
	}

	/** Rejects agent work on columns the acting account cannot write right now. */
	private agentAccessFailure(accountId: unknown): Response | null {
		if (isReadOnlyMode(this.env)) return readOnlyModeResponse();
		if (typeof accountId !== "string" || !this.meta || this.isTrashed() || !hasColumnAccess(this.meta, accountId)) {
			return Response.json({ ok: false, code: "not_found" }, { status: 404 });
		}
		return null;
	}

	private async handleAgentEdit(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			accountId: string;
			connectionId: string;
			agentName: string;
			tool: string;
			requiredLevel: string;
			edit: AgentEdit;
		};
		// Rechecked here, after the Worker's decision: membership and trash are authoritative in this object.
		const denied = this.agentAccessFailure(body.accountId);
		if (denied) return denied;
		const id = `chg_${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
		let failure: unknown = null;
		const outcome = this.commitAgentWork(
			(scratch) => {
				const result = applyAgentEdit(scratch, body.edit, AGENT_ORIGIN);
				if (!result.ok) failure = result.failure;
				return result.ok ? result : null;
			},
			(result) => {
				if (!result.changed) return;
				this.ctx.storage.sql.exec(
					`INSERT INTO agent_changes
					 (id, connection_id, account_id, agent_name, tool, required_level, summary, item_ids, undo, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					body.connectionId,
					normalizeAccountId(body.accountId),
					body.agentName,
					body.tool,
					body.requiredLevel,
					result.summary,
					JSON.stringify(result.itemIds),
					JSON.stringify(result.undo),
					Date.now(),
				);
				this.pruneAgentChanges();
			},
		);
		if (!outcome) return Response.json({ ok: false, failure }, { status: 409 });
		return Response.json({
			ok: true,
			changeId: outcome.changed ? id : null,
			version: outcome.version,
			itemIds: outcome.itemIds,
			summary: outcome.summary,
		});
	}

	private async handleAgentUndo(request: Request): Promise<Response> {
		const body = (await request.json()) as { accountId: string; changeId: string; connectionId?: string; grantedLevel?: AgentGrantLevel };
		const denied = this.agentAccessFailure(body.accountId);
		if (denied) return denied;
		const row = this.ctx.storage.sql
			.exec<{ undo: string; undone_at: number | null; connection_id: string; required_level: string }>(
				"SELECT undo, undone_at, connection_id, required_level FROM agent_changes WHERE id = ?",
				body.changeId,
			)
			.toArray()[0];
		// An agent may undo only its own changes; people may undo any agent's.
		if (!row || (body.connectionId !== undefined && row.connection_id !== body.connectionId)) {
			return Response.json({ ok: false, code: "change_not_found" }, { status: 404 });
		}
		if (row.undone_at !== null) return Response.json({ ok: false, code: "already_undone" }, { status: 409 });
		if (body.grantedLevel !== undefined && !agentLevelIncludes(body.grantedLevel, row.required_level as AgentGrantLevel)) {
			return Response.json({ ok: false, code: "insufficient_grant" }, { status: 403 });
		}
		const record = JSON.parse(row.undo) as UndoRecord;
		const outcome = this.commitAgentWork(
			(scratch) => undoAgentChange(scratch, record, AGENT_ORIGIN),
			(result) => {
				this.ctx.storage.sql.exec(
					"UPDATE agent_changes SET undone_at = ?, undone_by = ?, undo_result = ? WHERE id = ?",
					Date.now(),
					body.connectionId ? `agent:${body.connectionId}` : normalizeAccountId(body.accountId),
					JSON.stringify(result),
					body.changeId,
				);
			},
		)!;
		return Response.json({ ok: true, ...outcome });
	}

	private listAgentChanges(): Response {
		const rows = this.ctx.storage.sql
			.exec<AgentChangeRow>(
				`SELECT id, connection_id, account_id, agent_name, tool, summary, item_ids, undo, created_at, undone_at, undone_by, undo_result
				 FROM agent_changes ORDER BY created_at DESC, id LIMIT 200`,
			)
			.toArray();
		let current: Map<string, FieldValues> | null = null;
		const currentItem = (id: string) => (current ??= currentItemFields(this.doc)).get(id);
		return Response.json({
			changes: rows.map((row) => ({
				id: row.id,
				agentId: row.connection_id,
				agentName: row.agent_name,
				accountId: row.account_id,
				tool: row.tool,
				summary: row.summary,
				itemIds: JSON.parse(row.item_ids) as string[],
				createdAt: row.created_at,
				undoneAt: row.undone_at,
				undoneBy: row.undone_by,
				undoResult: row.undo_result ? (JSON.parse(row.undo_result) as unknown) : null,
				diff: describeAgentChange(JSON.parse(row.undo) as UndoRecord, currentItem),
			})),
		});
	}

	private hasAccess(accountId: string | null, isPublic: boolean): boolean {
		if (!this.meta) return false;
		if (isPublic && this.meta.publicId) return true;
		if (!accountId) return false;

		return hasColumnAccess(this.meta, accountId);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Preserve the original bytes for incident recovery even when Yjs cannot
		// decode them. Raw exports are internal DO calls, never public routes.
		if (request.method === "GET" && url.pathname === "/export-raw") {
			const snapshot = this.ctx.storage.sql.exec<{ snapshot: ArrayBuffer }>(
				"SELECT snapshot FROM yjs_snapshot WHERE id = 1",
			).toArray()[0];
			return Response.json({
				schemaVersion: 1,
				loadError: this.storageLoadError,
				meta: this.ctx.storage.sql.exec("SELECT meta FROM meta WHERE id = 1").toArray(),
				snapshot: snapshot ? Array.from(new Uint8Array(snapshot.snapshot)) : null,
				updates: this.ctx.storage.sql.exec<{ seq: number; update_blob: ArrayBuffer; ts: number }>(
					"SELECT seq, update_blob, ts FROM yjs_updates ORDER BY seq",
				).toArray().map((row) => ({ seq: row.seq, ts: row.ts, bytes: Array.from(new Uint8Array(row.update_blob)) })),
			});
		}
		if (this.storageLoadError && url.pathname !== "/import") {
			return Response.json({ error: "column_storage_corrupt", code: "durable_object_unavailable" }, { status: 503 });
		}

		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocket(request);
		}

		if (request.method === "GET" && url.pathname === "/meta") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			return Response.json(this.meta);
		}

		// Agent access is decided against authoritative membership and trash state.
		if (request.method === "GET" && url.pathname === "/access-state") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			return Response.json({ meta: this.meta, trashed: this.isTrashed() });
		}

		if (request.method === "POST" && url.pathname === "/agent-edit") return this.handleAgentEdit(request);
		if (request.method === "POST" && url.pathname === "/agent-undo") return this.handleAgentUndo(request);
		if (request.method === "GET" && url.pathname === "/agent-changes") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			return this.listAgentChanges();
		}

		if (request.method === "GET" && url.pathname === "/yjs-state") {
			if (!this.meta) return new Response("Column not found", { status: 404 });
			return new Response(toArrayBuffer(encodeStateAsUpdate(this.doc)), { headers: { "Content-Type": "application/octet-stream" } });
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
			if (this.isTrashed()) return Response.json({ code: "durable_object_unavailable", error: "Column is in trash" }, { status: 503 });
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();

			const accountId = request.headers.get("X-Authenticated-Account-ID");
			if (!this.meta) {
				return Response.json(
					{
						error: "Column not found",
						code: "not_found",
						message: "Column not found",
					},
					{ status: 404 },
				);
			}
			if (!this.hasAccess(accountId, false)) {
				return Response.json(
					{
						error: "Access denied",
						code: "access_revoked",
						message: "Access denied",
					},
					{ status: 403 },
				);
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
			// Initial creation records active state. Legacy rooms have no row until
			// their first lifecycle operation, allowing safe legacy trash cleanup.
			this.ctx.storage.sql.exec("INSERT OR IGNORE INTO column_lifecycle VALUES (1, NULL)");
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
					this.ctx.storage.sql.exec("INSERT INTO column_lifecycle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET trashed_at = excluded.trashed_at", parsed.data.trashedAt ?? null);
					this.persistMetaValue(parsed.data.meta);
					this.persistSnapshotBytes(snapshot);
					this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
					this.ctx.storage.sql.exec("DELETE FROM received_outbox");
					this.ctx.storage.sql.exec("DELETE FROM ws_tickets");
					// Recorded changes describe content this import replaces.
					this.ctx.storage.sql.exec("DELETE FROM agent_changes");
				});
			} catch (err) {
				candidateDoc.destroy();
				console.error("Failed to persist imported column state:", err);
				return Response.json({ error: "import_persist_failed" }, { status: 500 });
			}

			this.closeDeletedSessions();
			const previousDoc = this.doc;
			this.meta = parsed.data.meta;
			this.doc = candidateDoc;
			this.storageLoadError = null;
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

		if (request.method === "POST" && url.pathname === "/trash") {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();
			if (!this.meta) return new Response("Column not found", { status: 404 });
			const { deletedAt } = await request.json() as { deletedAt: number };
			if (!Number.isFinite(deletedAt) || deletedAt < 0) return new Response("Invalid deletion timestamp", { status: 400 });
			this.ctx.storage.sql.exec("INSERT INTO column_lifecycle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET trashed_at = excluded.trashed_at", deletedAt);
			this.closeDeletedSessions();
			return Response.json({ success: true });
		}
		if (request.method === "POST" && url.pathname === "/restore-active") {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();
			if (!this.meta) return new Response("Column not found", { status: 404 });
			const row = this.ctx.storage.sql.exec<{ trashed_at: number | null }>("SELECT trashed_at FROM column_lifecycle WHERE id = 1").toArray()[0];
			if (row?.trashed_at !== undefined && row.trashed_at !== null && Date.now() - row.trashed_at >= TRASH_RETENTION_MS) return new Response("Column expired", { status: 410 });
			this.ctx.storage.sql.exec("INSERT INTO column_lifecycle VALUES (1, NULL) ON CONFLICT(id) DO UPDATE SET trashed_at = NULL");
			return Response.json({ success: true });
		}
		if (request.method === "DELETE" && url.pathname === "/purge") {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();
			const { deletedAt, ownerId } = await request.json() as { deletedAt: number; ownerId: string };
			if (!Number.isFinite(deletedAt) || Date.now() - deletedAt < TRASH_RETENTION_MS) return new Response("Column has not expired", { status: 409 });
			if (!this.meta) return Response.json({ success: true });
			if (!isColumnOwner(this.meta, ownerId)) return new Response("Owner mismatch", { status: 409 });
			const row = this.ctx.storage.sql.exec<{ trashed_at: number | null }>("SELECT trashed_at FROM column_lifecycle WHERE id = 1").toArray()[0];
			// A restore marks this row active in the same transaction as import.
			// No stale purge invocation can cross that boundary and delete it.
			if (row && row.trashed_at !== deletedAt) return new Response("Column lifecycle changed", { status: 409 });
			this.closeDeletedSessions();
			this.ctx.storage.transactionSync(() => {
				for (const table of ["meta", "yjs_snapshot", "yjs_updates", "received_outbox", "ws_tickets", "agent_changes", "column_lifecycle"]) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
			});
			this.meta = null;
			this.doc.destroy(); this.doc = new Y.Doc();
			return Response.json({ success: true });
		}

		if (request.method === "DELETE" && url.pathname === "/") {
			if (isReadOnlyMode(this.env)) return readOnlyModeResponse();
			this.closeDeletedSessions();
			await this.ctx.storage.deleteAll();
			this.meta = null;
			this.sessions.clear();
			this.destroyAwareness();
			this.doc = new Y.Doc();
			return Response.json({ success: true });
		}

		return new Response("Not found", { status: 404 });
	}

	private isTrashed(): boolean {
		const row = this.ctx.storage.sql.exec<{ trashed_at: number | null }>("SELECT trashed_at FROM column_lifecycle WHERE id = 1").toArray()[0];
		return !!row && row.trashed_at !== null;
	}

	private closeDeletedSessions() {
		this.broadcast({ type: "column-deleted" });
		for (const ws of this.sessions.keys()) ws.close(1000, "Column deleted");
		this.sessions.clear();
		this.destroyAwareness();
	}

	private async handleWebSocket(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (this.isTrashed()) return new Response("Column is in trash", { status: 503 });
		let accountId: string | null = null;
		const requestedProtocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
			.split(",")
			.map((protocol) => protocol.trim())
			.filter(Boolean);
		const selectedProtocol = requestedProtocols.includes(WS_PROTOCOL_V1)
			? WS_PROTOCOL_V1
			: null;
		if (requestedProtocols.length > 0 && !selectedProtocol) {
			return new Response("Unsupported WebSocket protocol", {
				status: 426,
				headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL_V1 },
			});
		}

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

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: selectedProtocol
				? { "Sec-WebSocket-Protocol": selectedProtocol }
				: undefined,
		});
	}

	private sendInitialSync(ws: WebSocket) {
		const update = encodeStateAsUpdate(this.doc);
		ws.send(encodeServerMessage({ type: "sync", data: update }));

		const awareness = this.getAwareness();
		const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
			awareness,
			Array.from(awareness.getStates().keys()),
		);
		ws.send(encodeServerMessage({ type: "awareness", data: awarenessUpdate }));

		this.sendPresence(ws);
	}

	private rejectWritableSocket(ws: WebSocket) {
		const message = readOnlyModeWebSocketMessage();
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(encodeServerMessage({ type: "error", message }));
		}
		ws.close(1013, "Read-only mode");
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		let session = this.sessions.get(ws);
		if (!session) {
			const attachment = ws.deserializeAttachment();
			if (attachment) {
				session = attachment as SessionInfo;
				this.sessions.set(ws, session);
			}
		}
		if (!session) return;
		if (session.legacy) {
			this.sessions.delete(ws); ws.close(1008, "Sign in with your passkey"); return;
		}
		if (this.storageLoadError) {
			ws.close(1011, "Stored column requires recovery");
			return;
		}

		if (typeof message === "string") {
			ws.send(encodeServerMessage({ type: "error", message: "Binary WebSocket required" }));
			ws.close(1003, "Binary WebSocket required");
			return;
		}
		if (message.byteLength > MAX_WS_FRAME_BYTES) {
			ws.close(1009, "WebSocket frame too large");
			return;
		}

		try {
			const { op, payload } = decodeWsFrame(message);
			if (!isWsPayloadWithinLimit(op, payload.byteLength)) {
				ws.close(1009, "WebSocket payload too large");
				return;
			}
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
								encodeServerMessage({ type: "error", message: "Malformed sync submission" }),
							);
							break;
						}
						if (!session.accountId) {
							ws.close(1008, "Authenticated account required");
							break;
						}
						await this.applyDurableUpdate(
							submission.update,
							submission.outboxId,
							normalizeAccountId(session.accountId),
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
					ws.send(encodeServerMessage({ type: "error", message: `Unknown opcode: ${op}` }));
			}
		} catch (err) {
			console.error("Error handling binary message:", err);
		}
	}

	private async applyDurableUpdate(
		update: Uint8Array,
		outboxId: string,
		accountId: string,
		origin: WebSocket,
	): Promise<void> {
		if (isReadOnlyMode(this.env)) {
			this.rejectWritableSocket(origin);
			return;
		}

		try {
			Y.decodeUpdate(update);
		} catch {
			origin.send(encodeServerMessage({ type: "error", message: "Malformed Yjs update" }));
			origin.close(1007, "Malformed Yjs update");
			return;
		}

		const digest = await updateDigest(update);
		// Recheck after yielding: a delete, restore or access revocation may have run.
		if (this.storageLoadError || !this.meta || this.isTrashed() || !this.sessions.has(origin) || !hasColumnAccess(this.meta, accountId)) return;
		const outcome = this.ctx.storage.transactionSync<
			"inserted" | "duplicate" | "conflict"
		>(() => {
			const existing = this.ctx.storage.sql
				.exec<{ update_digest: string }>(
					`SELECT update_digest FROM received_outbox
					 WHERE account_id = ? AND outbox_id = ?`,
					accountId,
					outboxId,
				)
				.toArray()[0];
			if (existing) {
				return existing.update_digest === digest ? "duplicate" : "conflict";
			}

			this.ctx.storage.sql.exec(
				`INSERT INTO received_outbox
				 (account_id, outbox_id, update_digest, received_at)
				 VALUES (?, ?, ?, ?)`,
				accountId,
				outboxId,
				digest,
				Date.now(),
			);
			this.insertUpdateRow(update);
			return "inserted";
		});

		if (outcome === "duplicate") {
			// Replaying into a fresh tab must hydrate that tab too, even when
			// this delivery was already durable before its previous socket closed.
			origin.send(encodeServerMessage({ type: "sync", data: update }));
			origin.send(encodeServerMessage({ type: "sync-ack", outboxId }));
			return;
		}
		if (outcome === "conflict") {
			origin.send(
				encodeServerMessage({ type: "error", message: "Sync delivery ID reused with different content" }),
			);
			origin.close(1008, "Conflicting sync delivery ID");
			return;
		}

		applyUpdate(this.doc, update, origin);
		this.scheduleCompaction();

		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				// Echo before acknowledging: a new tab replaying another tab
				// has not applied these bytes to its own in-memory Y.Doc yet.
				ws.send(encodeServerMessage({ type: "sync", data: update }));
			}
		}

		origin.send(encodeServerMessage({ type: "sync-ack", outboxId }));
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
				ws.send(encodeServerMessage({ type: "awareness", data: update }));
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
		ws.send(encodeServerMessage({ type: "presence", users }));
	}

	private broadcastPresence() {
		const users = this.getPresenceUsers();
		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(encodeServerMessage({ type: "presence", users }));
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
				ws.send(encodeServerMessage({ type: "access-revoked" }));
				ws.close(1000, "Access revoked");
			}
		}
	}

	private broadcast(message: SyncMessage) {
		const frame = encodeServerMessage(message);
		for (const [ws] of this.sessions) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(frame);
			}
		}
	}
}

type AgentChangeRow = {
	id: string;
	connection_id: string;
	account_id: string;
	agent_name: string;
	tool: string;
	summary: string;
	item_ids: string;
	undo: string;
	created_at: number;
	undone_at: number | null;
	undone_by: string | null;
	undo_result: string | null;
};

interface SessionInfo {
	/** Reject hibernated sockets from the retired credential scheme. Never set on new sessions. */
	legacy?: boolean;
	accountId: string | null;
	isPublic: boolean;
	readOnly: boolean;
	connectedAt: number;
}
