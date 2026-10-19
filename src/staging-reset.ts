/**
 * Staging-only data reset, imported only by the staging entry point. Every
 * drill starts from an empty staging deployment, so a run's duration and
 * outcome never depend on data left by earlier runs (including runs that
 * aborted before cleaning up).
 *
 * Work is bounded per request (Workers cap subrequests per invocation): each
 * call deletes up to RESET_BATCH items and reports whether anything remains;
 * callers repeat until `done`.
 */
import type { Bindings } from "./index";
import { accountRecordStore } from "./server/account-record-store";
import { mapWithConcurrency } from "./server/bounded-concurrency";

const RESET_BATCH = 150;
/** R2 lists and deletes up to 1000 keys in one call each. */
const R2_BATCH = 1000;
const RESET_CONCURRENCY = 8;
// Children before parents. Agent credentials go with the accounts they act for:
// a reset must never leave a token or OAuth client from an earlier run.
const AUTH_TABLES = [
	"oauth_code",
	"agent_token",
	"agent_grant",
	"agent_connection",
	"oauth_client",
	"session",
	"account",
	"passkey",
	"verification",
	"user",
] as const;

async function listKvKeys(env: Bindings, prefix: string, limit: number): Promise<string[]> {
	const page = await env.ACCOUNTS.list({ prefix, limit });
	return page.keys.map((key) => key.name);
}

export async function resetStagingData(
	env: Bindings,
	batch = RESET_BATCH,
): Promise<{ done: boolean; deleted: Record<string, number> }> {
	const deleted = { columns: 0, accounts: 0, kvKeys: 0, backupObjects: 0, authRows: 0 };

	// Columns first: their Durable Object storage is unreachable once the registry is gone.
	const registry = await listKvKeys(env, "column-registry:", batch);
	await mapWithConcurrency(registry, RESET_CONCURRENCY, async (key) => {
		const columnId = key.slice("column-registry:".length);
		const response = await env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId)).fetch(
			new Request("http://do/", { method: "DELETE" }),
		);
		if (!response.ok) throw new Error(`column ${columnId} reset failed (${response.status})`);
		await env.ACCOUNTS.delete(key);
		deleted.columns++;
	});
	if (registry.length === batch) return { done: false, deleted };

	// Account roots live in each account's coordinator, mirrored to KV for listing.
	const accounts = await listKvKeys(env, "account:", batch);
	const records = accountRecordStore(env);
	await mapWithConcurrency(accounts, RESET_CONCURRENCY, async (key) => {
		const accountId = key.slice("account:".length);
		for (const prefix of ["account", "shared", "trash"]) await records.delete(`${prefix}:${accountId}`);
		await env.ACCOUNTS.delete(key);
		deleted.accounts++;
	});
	if (accounts.length === batch) return { done: false, deleted };

	// Everything else in KV: projections, journal entries, markers.
	const rest = await listKvKeys(env, "", batch);
	await mapWithConcurrency(rest, RESET_CONCURRENCY, async (key) => {
		await env.ACCOUNTS.delete(key);
		deleted.kvKeys++;
	});
	if (rest.length === batch) return { done: false, deleted };

	if (env.BACKUPS) {
		const objects = await env.BACKUPS.list({ limit: batch === RESET_BATCH ? R2_BATCH : batch });
		if (objects.objects.length) await env.BACKUPS.delete(objects.objects.map((object) => object.key));
		deleted.backupObjects = objects.objects.length;
		if (objects.truncated) return { done: false, deleted };
	}

	for (const table of AUTH_TABLES) {
		const result = await env.AUTH_DB.prepare(`DELETE FROM "${table}"`).run();
		deleted.authRows += result.meta.changes ?? 0;
	}
	return { done: true, deleted };
}
