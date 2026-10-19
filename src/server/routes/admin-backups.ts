import { restoreAccountBackup } from "../workflows/restore-account-backup";
import { createAccountBackup, readAccountBackup } from "../account-backup";
import { latestColumnBackupKey, listColumnBackups } from "../backup-catalog";
import { type Context } from "hono";
import { z } from "zod";
import type { ColumnMeta } from "../../types/account";
import { normalizeAccountId, displayAccountId } from "../../lib/account";
import { accountIdContractSchema } from "../../lib/api/account-contract";
import { parseAccountRecord, parseColumnMetaRecord, parseDeletedColumnRecords } from "../persistence-records";
import { cloneColumnSnapshot } from "../workflows/clone-column-snapshot";
import { restoreColumnBackup } from "../workflows/restore-column-backup";
import { accountRecordStore } from "../account-record-store";
import { isReadOnlyMode } from "../read-only-mode";
import { type Bindings } from "../bindings";
import { apiErrorResponse, schemaErrorResponse } from "../http/responses";
import { columnPathSchema, validateJsonBody, validateRequestInput } from "../http/request-validation";
import {
	collectRegisteredColumns,
	createColumnBackupSnapshot,
	createPreRestoreColumnBackup,
	isAutoBackupEnabled,
	readAndVerifyColumnBackup,
	rebuildSharedIndexesForColumns,
	restoreColumnFromBackupPayload,
	runScheduledBackups,
} from "../column-backups";
import type { App } from "../bindings";

export function requireBackupAdmin(c: Context<{ Bindings: Bindings }>): Response | null {
	if (!c.env.BACKUPS) {
		return c.json({ error: "backup_not_configured" }, 503);
	}

	if (!c.env.BACKUP_ADMIN_TOKEN) {
		return c.json({ error: "backup_auth_not_configured" }, 503);
	}

	const parsedAuthHeader = z
		.string()
		.regex(/^Bearer .+$/)
		.safeParse(c.req.header("Authorization"));
	const token = parsedAuthHeader.success
		? parsedAuthHeader.data.slice("Bearer ".length)
		: null;

	if (!token || token !== c.env.BACKUP_ADMIN_TOKEN) {
		return c.json({ error: "unauthorized" }, 401);
	}

	return null;
}

export const backupListQuerySchema = z
	.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
	.strict();

export const backupRestoreBodySchema = z
	.object({
		key: z.string().min(1).max(1024).optional(),
		mode: z.enum(["clone", "in_place"]).optional(),
	})
	.strict();

export const accountAdminBodySchema = z.object({ accountId: accountIdContractSchema, key: z.string().optional() }).strict();

export function registerAdminBackupRoutes(app: App) {
	app.get("/api/admin/backups/status", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const state = await c.env.BACKUPS!.get("backup-state.json");
		return c.json({ automaticBackupsEnabled: isAutoBackupEnabled(c.env), lastRun: state ? await state.json() : null });
	});

	// Private export endpoints let an independent machine retain verified copies
	// without relying on continued access to the Cloudflare account.
	app.get("/api/admin/backups/objects", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const page = await c.env.BACKUPS!.list({ limit: 1000, cursor: c.req.query("cursor") });
		return c.json({ objects: page.objects.map(object => ({ key: object.key, size: object.size })), truncated: page.truncated, cursor: page.truncated ? page.cursor : null }, 200, { "Cache-Control": "private, no-store" });
	});

	app.get("/api/admin/backups/download", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const key = c.req.query("key");
		if (!key) return c.json({ error: "missing_key" }, 400);
		const object = await c.env.BACKUPS!.get(key);
		if (!object) return c.json({ error: "not_found" }, 404);
		return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
	});

	// Authenticated manual execution provides a verifiable first backup immediately
	// after a release. It copies data only; scheduled maintenance remains frozen.
	app.post("/api/admin/backups/run", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		return c.json(await runScheduledBackups(c.env));
	});

	app.post("/api/admin/backups/account", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const body = await validateJsonBody(c, accountAdminBodySchema);
		if (!body.ok) return body.response;
		const accountId = normalizeAccountId(body.data.accountId);
		// Only this account's registered columns: scanning every account made one
		// account's backup cost grow with the whole system.
		const registered = await collectRegisteredColumns(c.env);
		const record = await accountRecordStore(c.env).get(`account:${accountId}`);
		if (!record) return c.json({ error: "account_not_found" }, 404);
		const parsed = parseAccountRecord(record);
		const trash = parseDeletedColumnRecords(await accountRecordStore(c.env).get(`trash:${accountId}`));
		if (!parsed.ok || !trash.ok) return c.json({ error: "account_invalid" }, 400);
		for (const columnId of new Set([...parsed.value.columnOrder, ...trash.value.map(row => row.columnId), ...(registered.columnsByOwner.get(accountId) ?? [])])) {
			const column = await createColumnBackupSnapshot(c.env, columnId);
			if (column.checksum === "raw-recovery-source") return c.json({ error: "column_corrupt", columnId }, 503);
		}
		const snapshot = await createAccountBackup(c.env, accountId, registered.columnsByOwner.get(accountId));
		if (!snapshot) return c.json({ error: "account_not_found" }, 404);
		return c.json({ success: true, key: snapshot.key, columnIds: snapshot.payload.columnIds });
	});

	/**
	 * Restore all owned columns for an account from latest backups
	 */
	app.post("/api/admin/backups/account/restore", async (c) => {
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		if (!isReadOnlyMode(c.env)) return c.json({ error: "maintenance_mode_required" }, 409);
		const body = await validateJsonBody(c, accountAdminBodySchema);
		if (!body.ok) return body.response;
		const accountId = body.data.accountId;

		const normalizedId = normalizeAccountId(accountId);
		try {
			const backup = await readAccountBackup(c.env, normalizedId, body.data.key);
			if (backup) return c.json(await restoreAccountBackup(c.env, backup,
				columnId => createPreRestoreColumnBackup(c.env, columnId)));
		} catch (error) {
			return c.json({ error: "account_recovery_failed", detail: error instanceof Error ? error.message : "unknown" }, 500);
		}
		const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);
		if (!accountData) {
			return apiErrorResponse("not_found", "Account not found", 404);
		}

		const parsedAccount = parseAccountRecord(accountData);
		if (!parsedAccount.ok) {
			return schemaErrorResponse("account", parsedAccount);
		}

		const account = parsedAccount.value;
		const restoredColumns: string[] = [];
		const missingBackups: string[] = [];
		const failedColumns: string[] = [];
		const restoredMetas: ColumnMeta[] = [];
		const failures: Array<{ columnId: string; key: string; code: string }> = [];

		for (const columnId of account.columnOrder) {
			let latestKey = "";
			try {
				latestKey = (await latestColumnBackupKey(c.env.BACKUPS!, columnId)) ?? "";

				if (!latestKey) {
					missingBackups.push(columnId);
					continue;
				}

				const object = await c.env.BACKUPS!.get(latestKey);
				if (!object) {
					missingBackups.push(columnId);
					continue;
				}

				const parsed = await readAndVerifyColumnBackup(object, columnId);
				if (!parsed.ok) {
					failedColumns.push(columnId);
					failures.push({ columnId, key: latestKey, code: parsed.code });
					continue;
				}

				const restored = await restoreColumnFromBackupPayload(
					c.env,
					columnId,
					parsed.payload,
				);
				if (!restored.ok) {
					failedColumns.push(columnId);
					failures.push({ columnId, key: latestKey, code: restored.code });
					continue;
				}

				restoredColumns.push(columnId);
				restoredMetas.push(restored.meta);
			} catch (error) {
				console.error("Account backup restore failed for column", { columnId, error });
				failedColumns.push(columnId);
				failures.push({ columnId, key: latestKey, code: "backup_read_failed" });
			}
		}

		await rebuildSharedIndexesForColumns(c.env, restoredMetas);

		return c.json({
			success:
				failedColumns.length === 0 &&
				missingBackups.length === 0 &&
				restoredColumns.length === account.columnOrder.length,
			accountId: displayAccountId(accountId),
			restoredColumns,
			missingBackups,
			failedColumns,
			failures,
		});
	});

	/**
	 * List available backups for a column
	 */
	app.get("/api/admin/backups/column/:id", async (c) => {
		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const query = validateRequestInput(c, backupListQuerySchema, {
			limit: c.req.query("limit"),
		});
		if (!query.ok) return query.response;
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const columnId = path.data.id;
		const limit = query.data.limit;
		const listed = await listColumnBackups(c.env.BACKUPS!, columnId);

		const objects = listed.slice(0, limit)
			.map((obj) => ({
				key: obj.key,
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
			}))
			.sort((a, b) => b.key.localeCompare(a.key));

		return c.json({
			columnId,
			objects,
			truncated: listed.length > limit,
		});
	});

	/**
	 * Create a backup snapshot for a column
	 */
	app.post("/api/admin/backups/column/:id", async (c) => {
		const request = validateRequestInput(c, columnPathSchema, {
			id: c.req.param("id"),
		});
		if (!request.ok) return request.response;
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const columnId = request.data.id;
		try {
			const { key, snapshotAt, checksum } = await createColumnBackupSnapshot(
				c.env,
				columnId,
			);

			return c.json({ success: true, key, snapshotAt, checksum });
		} catch (error) {
			if (error instanceof Error && error.message === "column_not_found") {
				return apiErrorResponse("not_found", "Column not found", 404);
			}

			return c.json({ error: "backup_failed" }, 500);
		}
	});

	/**
	 * Restore a column from backup snapshot
	 */
	app.post("/api/admin/backups/column/:id/restore", async (c) => {
		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const body = await validateJsonBody(c, backupRestoreBodySchema, {
			optional: true,
		});
		if (!body.ok) return body.response;
		const authError = requireBackupAdmin(c);
		if (authError) return authError;
		const columnId = path.data.id;
		const mode = body.data.mode ?? "clone";
		if (mode === "in_place" && !isReadOnlyMode(c.env)) return c.json({ error: "maintenance_mode_required" }, 409);

		let key = body.data.key;
		if (!key) {
			const latest = await latestColumnBackupKey(c.env.BACKUPS!, columnId);
			if (!latest) {
				return c.json({ error: "backup_not_found" }, 404);
			}
			key = latest;
		}

		const object = await c.env.BACKUPS!.get(key);
		if (!object) {
			return c.json({ error: "backup_not_found" }, 404);
		}

		const verified = await readAndVerifyColumnBackup(object, columnId);
		if (!verified.ok) {
			return c.json({ error: verified.code }, 400);
		}
		const parsed = verified.payload;

		const parsedBackupMeta = parseColumnMetaRecord(parsed.meta);
		if (!parsedBackupMeta.ok) {
			return schemaErrorResponse("column_meta", parsedBackupMeta);
		}
		const backupMeta = parsedBackupMeta.value;

		if (mode === "clone") {
			const cloned = await cloneColumnSnapshot({
				env: c.env,
				ownerId: backupMeta.ownerId,
				snapshot: { meta: backupMeta, yjs: parsed.yjs },
			});
			if (!cloned.ok) {
				return c.json(
					{ error: cloned.code },
					cloned.code === "invalid_yjs_update" ? 422 : 500,
				);
			}

			return c.json({
				success: true,
				mode,
				restoredFrom: key,
				snapshotAt: parsed.snapshotAt,
				originalColumnId: columnId,
				restoredColumnId: cloned.column.id,
			});
		}

		const restored = await restoreColumnBackup({
			env: c.env,
			columnId,
			payload: parsed,
			createPreRestoreBackup: () => createPreRestoreColumnBackup(c.env, columnId),
		});
		if (!restored.ok) {
			const status =
				restored.code === "backup_checksum_mismatch" ||
					restored.code === "invalid_backup_payload" ||
					restored.code === "column_meta_invalid"
						? 400
						: restored.code === "invalid_yjs_update"
							? 422
							: 500;
			return c.json({ error: restored.code }, status);
		}

		return c.json({
			success: true,
			mode,
			restoredFrom: key,
			snapshotAt: parsed.snapshotAt,
			preRestoreBackupKey: restored.preRestoreBackupKey,
		});
	});
}
