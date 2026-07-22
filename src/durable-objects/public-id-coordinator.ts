import { DurableObject } from "cloudflare:workers";

interface PublicIdCoordinatorEnv {
	ACCOUNTS: KVNamespace;
}

interface PublicIdRow extends Record<string, SqlStorageValue> {
	public_id: string;
	column_id: string | null;
	dirty: number;
}

/** Atomically claims public IDs and projects their reverse lookup into KV. */
export class PublicIdCoordinatorSql extends DurableObject<PublicIdCoordinatorEnv> {
	private tail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: PublicIdCoordinatorEnv) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS public_id_claim (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				public_id TEXT NOT NULL,
				column_id TEXT,
				dirty INTEGER NOT NULL DEFAULT 0
			)
		`);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private load(): PublicIdRow | null {
		return (
			this.ctx.storage.sql
				.exec<PublicIdRow>(
					"SELECT public_id, column_id, dirty FROM public_id_claim WHERE id = 1",
				)
				.toArray()[0] ?? null
		);
	}

	private async bootstrap(publicId: string): Promise<PublicIdRow> {
		const row = this.load();
		if (row) return row;
		const columnId = await this.env.ACCOUNTS.get(`public:${publicId}`);
		this.ctx.storage.sql.exec(
			"INSERT INTO public_id_claim (id, public_id, column_id, dirty) VALUES (1, ?, ?, 0)",
			publicId,
			columnId,
		);
		return this.load() as PublicIdRow;
	}

	private async project(row: PublicIdRow): Promise<void> {
		try {
			if (row.column_id === null) {
				await this.env.ACCOUNTS.delete(`public:${row.public_id}`);
			} else {
				await this.env.ACCOUNTS.put(`public:${row.public_id}`, row.column_id);
			}
			this.ctx.storage.sql.exec("UPDATE public_id_claim SET dirty = 0 WHERE id = 1");
		} catch (error) {
			console.error("Public ID KV projection failed", {
				publicId: row.public_id,
				error: error instanceof Error ? error.message : String(error),
			});
			await this.ctx.storage.setAlarm(Date.now() + 5_000);
		}
	}

	private async handle(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const body = (await request.json().catch(() => null)) as {
			publicId?: unknown;
			columnId?: unknown;
		} | null;
		if (!body || typeof body.publicId !== "string") {
			return Response.json({ error: "Invalid public ID" }, { status: 400 });
		}
		const row = await this.bootstrap(body.publicId);
		const pathname = new URL(request.url).pathname;
		if (pathname === "/resolve") return Response.json({ columnId: row.column_id });
		if (typeof body.columnId !== "string") {
			return Response.json({ error: "Invalid column ID" }, { status: 400 });
		}

		if (pathname === "/claim") {
			if (row.column_id !== null && row.column_id !== body.columnId) {
				return Response.json({ claimed: false, columnId: row.column_id }, { status: 409 });
			}
			this.ctx.storage.sql.exec(
				"UPDATE public_id_claim SET column_id = ?, dirty = 1 WHERE id = 1",
				body.columnId,
			);
			await this.project(this.load() as PublicIdRow);
			return Response.json({ claimed: true });
		}

		if (pathname === "/release") {
			if (row.column_id === body.columnId) {
				this.ctx.storage.sql.exec(
					"UPDATE public_id_claim SET column_id = NULL, dirty = 1 WHERE id = 1",
				);
				await this.project(this.load() as PublicIdRow);
			}
			return Response.json({ released: row.column_id === body.columnId });
		}

		return new Response("Not Found", { status: 404 });
	}

	async fetch(request: Request): Promise<Response> {
		return this.enqueue(() => this.handle(request));
	}

	async alarm(): Promise<void> {
		await this.enqueue(async () => {
			const row = this.load();
			if (row?.dirty) await this.project(row);
		});
	}
}
