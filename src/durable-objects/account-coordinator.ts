import { DurableObject } from "cloudflare:workers";
import { reorderColumnOrder } from "../server/account-record-store";
import { parseDeletedColumnRecords } from "../server/persistence-records";

interface AccountCoordinatorEnv {
	ACCOUNTS: KVNamespace;
}

interface RecordRow extends Record<string, SqlStorageValue> {
	record_key: string;
	value: string | null;
	deleted: number;
	dirty: number;
}

type AccountMutation =
	| { kind: "account-add-column"; columnId: string; maxColumns?: number }
	| { kind: "account-remove-column"; columnId: string }
	| { kind: "account-reorder"; columnOrder: string[] }
	| { kind: "account-set-hidden"; hiddenSharedColumns: string[] }
	| { kind: "shared-add"; columnId: string }
	| { kind: "shared-remove"; columnId: string }
	| { kind: "trash-upsert"; columnId: string; deletedAt: number; retentionMs: number }
	| { kind: "trash-remove"; columnId: string };

function jsonError(message: string, status = 400): Response {
	return Response.json({ error: message }, { status });
}

/**
 * Strongly consistent writer for the account-scoped records that are projected
 * into Workers KV. The local SQLite row is authoritative after its first read;
 * failed KV projections are retried by an alarm without requiring another user
 * request.
 */
export class AccountCoordinatorSql extends DurableObject<AccountCoordinatorEnv> {
	private tail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: AccountCoordinatorEnv) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS account_records (
				record_key TEXT PRIMARY KEY,
				value TEXT,
				deleted INTEGER NOT NULL DEFAULT 0,
				dirty INTEGER NOT NULL DEFAULT 0
			)
		`);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private load(key: string): RecordRow | null {
		return (
			this.ctx.storage.sql
				.exec<RecordRow>(
					"SELECT record_key, value, deleted, dirty FROM account_records WHERE record_key = ?",
					key,
				)
				.toArray()[0] ?? null
		);
	}

	private async bootstrap(key: string): Promise<RecordRow> {
		const existing = this.load(key);
		if (existing) return existing;

		const value = await this.env.ACCOUNTS.get(key);
		this.ctx.storage.sql.exec(
			"INSERT INTO account_records (record_key, value, deleted, dirty) VALUES (?, ?, ?, 0)",
			key,
			value,
			value === null ? 1 : 0,
		);
		return this.load(key) as RecordRow;
	}

	private async project(row: RecordRow): Promise<boolean> {
		try {
			if (row.deleted !== 0) {
				await this.env.ACCOUNTS.delete(row.record_key);
			} else if (row.value !== null) {
				await this.env.ACCOUNTS.put(row.record_key, row.value);
			}
			this.ctx.storage.sql.exec(
				"UPDATE account_records SET dirty = 0 WHERE record_key = ?",
				row.record_key,
			);
			return true;
		} catch (error) {
			console.error("Account KV projection failed", {
				recordKey: row.record_key,
				error: error instanceof Error ? error.message : String(error),
			});
			await this.ctx.storage.setAlarm(Date.now() + 5_000);
			return false;
		}
	}

	private applyMutation(value: string | null, mutation: AccountMutation): string {
		switch (mutation.kind) {
		case "account-add-column":
		case "account-remove-column":
		case "account-reorder":
		case "account-set-hidden": {
			if (value === null) throw new Error("Account not found");
			const account = JSON.parse(value) as {
				columnOrder: string[];
				hiddenSharedColumns: string[];
			};
			if (mutation.kind === "account-add-column") {
				if (!account.columnOrder.includes(mutation.columnId)) {
					if (account.columnOrder.length >= (mutation.maxColumns ?? 100)) {
						throw new Error("Column limit reached");
					}
					account.columnOrder.push(mutation.columnId);
				}
			} else if (mutation.kind === "account-remove-column") {
				account.columnOrder = account.columnOrder.filter(
					(columnId) => columnId !== mutation.columnId,
				);
			} else if (mutation.kind === "account-reorder") {
				account.columnOrder = reorderColumnOrder(account.columnOrder, mutation.columnOrder);
			} else {
				account.hiddenSharedColumns = mutation.hiddenSharedColumns;
			}
			return JSON.stringify(account);
		}
		case "shared-add":
		case "shared-remove": {
			const columns = value === null ? [] : (JSON.parse(value) as string[]);
			const next =
				mutation.kind === "shared-add"
					? Array.from(new Set([...columns, mutation.columnId]))
					: columns.filter((columnId) => columnId !== mutation.columnId);
			return JSON.stringify(next);
		}
		case "trash-upsert":
		case "trash-remove": {
			const parsedTrash = parseDeletedColumnRecords(value);
			if (!parsedTrash.ok) throw new Error(`Trash record ${parsedTrash.code}`);
			const trash = parsedTrash.value;
			if (mutation.kind === "trash-remove") {
				return JSON.stringify(trash.filter((entry) => entry.columnId !== mutation.columnId));
			}
			const retained = trash.filter(
				(entry) =>
					mutation.deletedAt - entry.deletedAt < mutation.retentionMs &&
					entry.columnId !== mutation.columnId,
			);
			return JSON.stringify([
				{ columnId: mutation.columnId, deletedAt: mutation.deletedAt },
				...retained,
			]);
		}
		}
	}

	private async handle(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const pathname = new URL(request.url).pathname;
		const body = (await request.json().catch(() => null)) as {
			key?: unknown;
			value?: unknown;
		} | null;
		if (!body || typeof body.key !== "string") return jsonError("Invalid record key");
		const key = body.key;
		if (!/^(account|shared|trash):[0-9]+$/.test(key)) {
			return jsonError("Record is not account-scoped");
		}

		if (pathname === "/get") {
			const row = await this.bootstrap(key);
			return Response.json({ value: row.deleted !== 0 ? null : row.value });
		}

		if (pathname === "/put") {
			if (typeof body.value !== "string") return jsonError("Invalid record value");
			await this.bootstrap(key);
			this.ctx.storage.sql.exec(
				"UPDATE account_records SET value = ?, deleted = 0, dirty = 1 WHERE record_key = ?",
				body.value,
				key,
			);
			await this.project(this.load(key) as RecordRow);
			return Response.json({ stored: true });
		}

		if (pathname === "/delete") {
			await this.bootstrap(key);
			this.ctx.storage.sql.exec(
				"UPDATE account_records SET value = NULL, deleted = 1, dirty = 1 WHERE record_key = ?",
				key,
			);
			await this.project(this.load(key) as RecordRow);
			return Response.json({ deleted: true });
		}

		if (pathname === "/mutate") {
			const mutation = (body as { mutation?: AccountMutation }).mutation;
			if (!mutation || typeof mutation.kind !== "string") {
				return jsonError("Invalid mutation");
			}
			const row = await this.bootstrap(key);
			try {
				const value = this.applyMutation(row.deleted !== 0 ? null : row.value, mutation);
				this.ctx.storage.sql.exec(
					"UPDATE account_records SET value = ?, deleted = 0, dirty = 1 WHERE record_key = ?",
					value,
					key,
				);
				await this.project(this.load(key) as RecordRow);
				return Response.json({ value });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonError(message, message === "Account not found" ? 404 : 409);
			}
		}

		return new Response("Not Found", { status: 404 });
	}

	async fetch(request: Request): Promise<Response> {
		return this.enqueue(() => this.handle(request));
	}

	async alarm(): Promise<void> {
		await this.enqueue(async () => {
			const dirty = this.ctx.storage.sql
				.exec<RecordRow>(
					"SELECT record_key, value, deleted, dirty FROM account_records WHERE dirty = 1 ORDER BY record_key",
				)
				.toArray();
			let failed = false;
			for (const row of dirty) {
				if (!(await this.project(row))) failed = true;
			}
			if (failed) await this.ctx.storage.setAlarm(Date.now() + 30_000);
		});
	}
}
