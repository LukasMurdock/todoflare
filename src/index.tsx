import { sessionResponseCookies } from "./server/session";
import { Hono } from "hono";
import { ColumnRoomSql } from "./durable-objects/column-room";
import { IdempotencyCoordinatorSql } from "./durable-objects/idempotency-coordinator";
import { RateLimitCoordinatorSql } from "./durable-objects/rate-limit-coordinator";
import { AccountCoordinatorSql } from "./durable-objects/account-coordinator";
import { PublicIdCoordinatorSql } from "./durable-objects/public-id-coordinator";
import { API_ROUTES } from "./lib/api/routes";
import { BUILD_INFO } from "./lib/build-info";
import { purgeExpiredTrashedColumns } from "./server/workflows/purge-expired-trashed-columns";
import { reconcileColumnLifecycle } from "./server/workflows/reconcile-column-lifecycle";
import { isReadOnlyMode } from "./server/read-only-mode";
import { cleanupAbandonedProvisionalUsers } from "./server/auth";

import type { App, AppEnv, Bindings } from "./server/bindings";
import { createColumnBackupSnapshot, isAutoBackupEnabled, runScheduledBackups } from "./server/column-backups";
import { registerAccountCommandRoutes } from "./server/routes/account-commands";
import { registerAccountRoutes } from "./server/routes/account";
import { registerAdminBackupRoutes } from "./server/routes/admin-backups";
import { registerAuthRoutes, registerAuthStatusRoute } from "./server/routes/auth";
import { registerColumnRoutes } from "./server/routes/columns";
import { registerPublicRoutes } from "./server/routes/public";

export type { Bindings };
export { runScheduledBackups };

// Re-export Durable Objects for Cloudflare
export {
	AccountCoordinatorSql,
	ColumnRoomSql,
	IdempotencyCoordinatorSql,
	PublicIdCoordinatorSql,
	RateLimitCoordinatorSql,
};

const app: App = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
	await next();
	// Server-side getSession() can renew or expire cookies. Forward every cookie
	// individually, including on authentication failures; JSON alone loses them.
	for (const cookie of await sessionResponseCookies(c.req.raw)) {
		c.header("Set-Cookie", cookie, { append: true });
	}
});

registerAuthRoutes(app);

app.use("/api/*", async (c, next) => {
	if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
	const origin = c.req.header("Origin");
	const fetchSite = c.req.header("Sec-Fetch-Site");
	if (
		(origin && origin !== new URL(c.req.url).origin) ||
		fetchSite === "cross-site"
	) {
		return c.json({ error: "cross_origin_request", code: "unauthorized" }, 403);
	}
	return next();
});

registerAuthStatusRoute(app);
registerAccountRoutes(app);
registerAccountCommandRoutes(app);
registerColumnRoutes(app);
registerPublicRoutes(app);
registerAdminBackupRoutes(app);

// Keep the clock endpoint for testing
app.on(API_ROUTES.clock.method, API_ROUTES.clock.path, (c) => {
	return c.json(
		{
			time: new Date().toLocaleTimeString(),
			readOnlyMode: isReadOnlyMode(c.env),
			autoBackupEnabled: isAutoBackupEnabled(c.env),
			build: BUILD_INFO,
		},
		200,
		{ "Cache-Control": "no-store" },
	);
});

export default {
	fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, env, ctx),
	scheduled: async (
		controller: ScheduledController,
		env: Bindings,
		executionCtx: ExecutionContext,
	) => {
			executionCtx.waitUntil(
			(async () => {
				// Emergency read-only mode freezes scheduled maintenance as well as
				// user writes. Backups remain available while incidents are investigated.
				if (isReadOnlyMode(env)) return;
				await cleanupAbandonedProvisionalUsers(env);
				const reconciliationResult = await reconcileColumnLifecycle(env);
				env.LIFECYCLE_METRICS?.writeDataPoint({
					indexes: ["scheduled-reconciliation"],
					blobs: [controller.cron],
					doubles: [
						reconciliationResult.registryScanned,
						reconciliationResult.operationsRetried,
						reconciliationResult.operationsCompleted,
						reconciliationResult.operationsFailed,
						reconciliationResult.columnsInitialized,
						reconciliationResult.ownerMembershipRepaired,
						reconciliationResult.ownerMembershipRemoved,
						reconciliationResult.sharedMembershipRepaired,
						reconciliationResult.sharedMembershipRemoved,
						reconciliationResult.publicMappingsRepaired,
						reconciliationResult.publicMappingsRemoved,
						reconciliationResult.publicMappingConflicts,
						reconciliationResult.invalidRecords,
						reconciliationResult.trashRecordsInvalid,
					],
				});
				console.log(
					JSON.stringify({
						event: "scheduled_column_lifecycle_reconciliation",
						cron: controller.cron,
						...reconciliationResult,
					}),
				);
				const backupResult = isAutoBackupEnabled(env) ? await runScheduledBackups(env) : null;
				const purgeResult = await purgeExpiredTrashedColumns({
					env, beforeDelete: async (columnId) => { await createColumnBackupSnapshot(env, columnId); },
				});
				console.log(
					JSON.stringify({
						event: "scheduled_trash_purge_run",
						cron: controller.cron,
						...purgeResult,
					}),
				);

				if (!backupResult) return;
				console.log(
					JSON.stringify({
						event: "scheduled_backup_run",
						cron: controller.cron,
						...backupResult,
					}),
				);
			})(),
		);
	},
};
