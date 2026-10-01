import { z } from "zod";
import type { Bindings } from "../index";
import { normalizeAccountId } from "../lib/account";
import { accountRecordStore } from "./account-record-store";
import { parseAccountRecord, parseDeletedColumnRecords, parseSharedColumnIndex } from "./persistence-records";

const authTables = {
	user: ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "isAnonymous", "authState", "recoveryCodeHash"],
	passkey: ["id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "transports", "createdAt", "aaguid"],
	account: ["id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"],
} as const;
type AuthTable = keyof typeof authTables;
const authRowSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]));
type AuthRow = z.infer<typeof authRowSchema>;
const accountBackupSchema = z.object({
	schemaVersion: z.literal(1),
	accountId: z.string().regex(/^\d{16}$/),
	snapshotAt: z.number().int().nonnegative(),
	account: z.string(),
	sharedIndex: z.string().nullable(),
	trash: z.string().nullable(),
	columnIds: z.array(z.string()),
	auth: z.object({ user: authRowSchema.nullable(), passkey: z.array(authRowSchema), account: z.array(authRowSchema) }).strict(),
	checksum: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AccountBackup = z.infer<typeof accountBackupSchema>;

async function checksum(payload: Omit<AccountBackup, "checksum">): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Credentials are stored only in the private admin backup bucket, never logs. */
export async function createAccountBackup(
	env: Bindings,
	accountId: string,
	registryColumnIds: string[] = [],
	prefix = "accounts",
): Promise<{ key: string; payload: AccountBackup } | null> {
	if (!env.BACKUPS) throw new Error("backup_not_configured");
	const records = accountRecordStore(env);
	const account = await records.get(`account:${accountId}`);
	if (account === null) return null;
	const parsedAccount = parseAccountRecord(account);
	const sharedIndex = await records.get(`shared:${accountId}`);
	const trash = await records.get(`trash:${accountId}`);
	const parsedTrash = parseDeletedColumnRecords(trash);
	if (!parsedAccount.ok || !parsedTrash.ok || !parseSharedColumnIndex(sharedIndex).ok) throw new Error("account_backup_invalid_records");
	const auth = {
		user: await env.AUTH_DB.prepare('SELECT * FROM "user" WHERE id = ?').bind(accountId).first<AuthRow>(),
		passkey: (await env.AUTH_DB.prepare('SELECT * FROM passkey WHERE userId = ? ORDER BY id').bind(accountId).all<AuthRow>()).results,
		account: (await env.AUTH_DB.prepare('SELECT * FROM account WHERE userId = ? ORDER BY id').bind(accountId).all<AuthRow>()).results,
	};
	const base = {
		schemaVersion: 1 as const, accountId, snapshotAt: Date.now(), account, sharedIndex, trash,
		columnIds: Array.from(new Set([...parsedAccount.value.columnOrder, ...parsedTrash.value.map(row => row.columnId), ...registryColumnIds])).sort(),
		auth,
	};
	const payload: AccountBackup = { ...base, checksum: await checksum(base) };
	const key = `${prefix}/${accountId}/${String(base.snapshotAt).padStart(13, "0")}-${crypto.randomUUID()}.json`;
	await env.BACKUPS.put(key, JSON.stringify(payload), { httpMetadata: { contentType: "application/json" } });
	return { key, payload };
}

export async function readAccountBackup(env: Bindings, accountId: string, key?: string): Promise<AccountBackup | null> {
	if (!env.BACKUPS) throw new Error("backup_not_configured");
	if (!key) {
		let cursor: string | undefined;
		do {
			const page = await env.BACKUPS.list({ prefix: `accounts/${accountId}/`, cursor });
			for (const object of page.objects) if (!key || object.key > key) key = object.key;
			if (!page.truncated) break;
			if (!page.cursor || page.cursor === cursor) throw new Error("backup_pagination_invalid");
			cursor = page.cursor;
		} while (cursor);
	}
	if (!key) return null;
	if (!key.startsWith(`accounts/${accountId}/`)) throw new Error("account_backup_key_mismatch");
	const object = await env.BACKUPS.get(key);
	if (!object) throw new Error("account_backup_not_found");
	const payload = accountBackupSchema.parse(await object.json());
	const { checksum: stored, ...base } = payload;
	if (payload.accountId !== accountId || await checksum(base) !== stored) throw new Error("account_backup_checksum_mismatch");
	const account = parseAccountRecord(payload.account);
	const trash = parseDeletedColumnRecords(payload.trash);
	if (!account.ok || normalizeAccountId(account.value.id) !== accountId || !trash.ok || !parseSharedColumnIndex(payload.sharedIndex).ok) throw new Error("account_backup_invalid_records");
	for (const id of [...account.value.columnOrder, ...trash.value.map(row => row.columnId)]) if (!payload.columnIds.includes(id)) throw new Error("account_backup_missing_inventory");
	for (const table of Object.keys(authTables) as AuthTable[]) {
		const rows = table === "user" ? (payload.auth.user ? [payload.auth.user] : []) : payload.auth[table];
		for (const row of rows) {
			if (typeof row.id !== "string" || (table === "user" ? row.id : row.userId) !== accountId || Object.keys(row).some(key => !(authTables[table] as readonly string[]).includes(key))) throw new Error("account_backup_invalid_credentials");
		}
	}
	if (!payload.auth.user && (payload.auth.passkey.length || payload.auth.account.length)) throw new Error("account_backup_missing_auth_user");
	return payload;
}

/** Batch upserts preserve FK children; INSERT OR REPLACE on user would cascade. */
export async function restoreAccountCredentials(env: Bindings, payload: AccountBackup): Promise<void> {
	const statements: D1PreparedStatement[] = [];
	for (const table of Object.keys(authTables) as AuthTable[]) {
		const rows = table === "user" ? (payload.auth.user ? [payload.auth.user] : []) : payload.auth[table];
		for (const row of rows) {
			const keys = Object.keys(row);
			const quoted = keys.map(key => `"${key}"`);
			statements.push(env.AUTH_DB.prepare(
				`INSERT INTO "${table}" (${quoted.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${quoted.filter(key => key !== '"id"').map(key => `${key}=excluded.${key}`).join(",")}`,
			).bind(...keys.map(key => row[key])));
		}
	}
	// Recovered users authenticate again; sessions and challenges are ephemeral.
	statements.push(env.AUTH_DB.prepare('DELETE FROM session WHERE userId = ?').bind(payload.accountId));
	await env.AUTH_DB.batch(statements);
}
