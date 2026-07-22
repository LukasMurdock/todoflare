import { DurableObject } from "cloudflare:workers";

const RECORD_ID = 1;

type IdempotencyState = "pending" | "completed" | "indeterminate";

interface IdempotencyRow extends Record<string, SqlStorageValue> {
	fingerprint: string;
	state: IdempotencyState;
	owner_token: string;
	status: number | null;
	body: string | null;
	expires_at: number;
}

interface BeginRequest {
	fingerprint: string;
	pendingExpiresAt: number;
}

interface CompleteRequest {
	ownerToken: string;
	status: number;
	body: unknown;
	expiresAt: number;
}

interface MarkIndeterminateRequest {
	ownerToken: string;
	expiresAt: number;
}

function jsonError(message: string, status = 400): Response {
	return Response.json({ error: message }, { status });
}

export class IdempotencyCoordinatorSql extends DurableObject<unknown> {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS idempotency_record (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				fingerprint TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'indeterminate')),
				owner_token TEXT NOT NULL,
				status INTEGER,
				body TEXT,
				expires_at INTEGER NOT NULL
			)
		`);
	}

	private load(): IdempotencyRow | null {
		return (
			this.ctx.storage.sql
				.exec<IdempotencyRow>(
					"SELECT fingerprint, state, owner_token, status, body, expires_at FROM idempotency_record WHERE id = ?",
					RECORD_ID,
				)
				.toArray()[0] ?? null
		);
	}

	private async begin(request: BeginRequest): Promise<Response> {
		if (
			typeof request.fingerprint !== "string" ||
			request.fingerprint.length === 0 ||
			!Number.isFinite(request.pendingExpiresAt)
		) {
			return jsonError("Invalid idempotency begin request");
		}

		const now = Date.now();
		let row = this.load();
		if (row && row.expires_at <= now) {
			this.ctx.storage.sql.exec(
				"DELETE FROM idempotency_record WHERE id = ?",
				RECORD_ID,
			);
			row = null;
		}

		if (!row) {
			const ownerToken = crypto.randomUUID();
			this.ctx.storage.sql.exec(
				"INSERT INTO idempotency_record (id, fingerprint, state, owner_token, status, body, expires_at) VALUES (?, ?, 'pending', ?, NULL, NULL, ?)",
				RECORD_ID,
				request.fingerprint,
				ownerToken,
				request.pendingExpiresAt,
			);
			await this.ctx.storage.setAlarm(request.pendingExpiresAt);
			return Response.json({ kind: "acquired", ownerToken });
		}

		if (row.fingerprint !== request.fingerprint) {
			return Response.json({ kind: "conflict" });
		}

		if (row.state === "completed") {
			if (row.status === null || row.body === null) {
				return jsonError("Completed idempotency record is invalid", 500);
			}
			return Response.json({
				kind: "completed",
				status: row.status,
				body: JSON.parse(row.body) as unknown,
			});
		}

		return Response.json({ kind: row.state });
	}

	private async complete(request: CompleteRequest): Promise<Response> {
		if (
			typeof request.ownerToken !== "string" ||
			!Number.isInteger(request.status) ||
			!Number.isFinite(request.expiresAt)
		) {
			return jsonError("Invalid idempotency completion request");
		}

		const row = this.load();
		if (!row || row.state !== "pending" || row.owner_token !== request.ownerToken) {
			return Response.json({ stored: false }, { status: 409 });
		}

		this.ctx.storage.sql.exec(
			"UPDATE idempotency_record SET state = 'completed', status = ?, body = ?, expires_at = ? WHERE id = ? AND owner_token = ?",
			request.status,
			JSON.stringify(request.body),
			request.expiresAt,
			RECORD_ID,
			request.ownerToken,
		);
		await this.ctx.storage.setAlarm(request.expiresAt);
		return Response.json({ stored: true });
	}

	private async markIndeterminate(
		request: MarkIndeterminateRequest,
	): Promise<Response> {
		if (
			typeof request.ownerToken !== "string" ||
			!Number.isFinite(request.expiresAt)
		) {
			return jsonError("Invalid indeterminate request");
		}

		const row = this.load();
		if (!row || row.state !== "pending" || row.owner_token !== request.ownerToken) {
			return Response.json({ stored: false }, { status: 409 });
		}

		this.ctx.storage.sql.exec(
			"UPDATE idempotency_record SET state = 'indeterminate', expires_at = ? WHERE id = ? AND owner_token = ?",
			request.expiresAt,
			RECORD_ID,
			request.ownerToken,
		);
		await this.ctx.storage.setAlarm(request.expiresAt);
		return Response.json({ stored: true });
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

		const pathname = new URL(request.url).pathname;
		const body = (await request.json().catch(() => null)) as unknown;
		if (!body || typeof body !== "object") return jsonError("Expected JSON body");

		if (pathname === "/begin") return this.begin(body as BeginRequest);
		if (pathname === "/complete") return this.complete(body as CompleteRequest);
		if (pathname === "/indeterminate") {
			return this.markIndeterminate(body as MarkIndeterminateRequest);
		}

		return new Response("Not Found", { status: 404 });
	}

	async alarm(): Promise<void> {
		const row = this.load();
		if (!row) return;
		if (row.expires_at <= Date.now()) {
			this.ctx.storage.sql.exec(
				"DELETE FROM idempotency_record WHERE id = ?",
				RECORD_ID,
			);
			return;
		}
		await this.ctx.storage.setAlarm(row.expires_at);
	}
}
