/** Recovery controls exist only in the staging entry point. Never bind production here. */
import worker, { type Bindings } from "./index";
import { requireAccountCredential } from "./lib/http-account-auth";
import { accountRecordStore } from "./server/account-record-store";
import { readAccountBackup } from "./server/account-backup";
import { resetStagingData } from "./staging-reset";
import { isReadOnlyMode } from "./server/read-only-mode";
import {
	getClientIP,
	IP_RATE_LIMITED_ACTIONS,
	ipRateLimitKey,
	resetRateLimit,
} from "./lib/rate-limit";
export { AccountCoordinatorSql, ColumnRoomSql, IdempotencyCoordinatorSql, RateLimitCoordinatorSql, PublicIdCoordinatorSql } from "./index";

type StagingBindings = Bindings & { ENVIRONMENT?: string };
export default {
	...worker,
	async fetch(request: Request, env: StagingBindings, ctx: ExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (!path.startsWith("/api/admin/staging/")) return worker.fetch(request, env, ctx);
		if (env.ENVIRONMENT !== "staging") return new Response("Not found", { status: 404 });
		if (!env.BACKUP_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.BACKUP_ADMIN_TOKEN}`) return new Response("Unauthorized", { status: 401 });
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		if (path === "/api/admin/staging/scheduled") {
			const tasks: Promise<unknown>[] = [];
			await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env,
				{ ...ctx, waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as ExecutionContext);
			await Promise.all(tasks);
			return Response.json({ success: true, frozen: isReadOnlyMode(env) });
		}
		if (path === "/api/admin/staging/reset-rate-limits") {
			// Repeated drills create fresh accounts from one workstation; staging keeps
			// production limits, so the drill clears only its own IP's windows.
			const ip = getClientIP(request);
			for (const action of IP_RATE_LIMITED_ACTIONS) {
				await resetRateLimit(env.RATE_LIMIT_COORDINATOR, ipRateLimitKey(action, ip));
			}
			return Response.json({ success: true, reset: IP_RATE_LIMITED_ACTIONS });
		}
		if (path === "/api/admin/staging/reset-data") {
			// Drills start from empty storage; see staging-reset.ts. Repeat until done.
			if (isReadOnlyMode(env)) return new Response("Frozen", { status: 409 });
			return Response.json(await resetStagingData(env));
		}
		if (path === "/api/admin/staging/mark-drill") {
			if (isReadOnlyMode(env)) return new Response("Frozen", { status: 409 });
			const credential = await requireAccountCredential(request, env);
			if (!credential.ok) return credential.response;
			await env.ACCOUNTS.put(`staging-drill:${credential.accountId}`, "synthetic-recovery-case");
			return Response.json({ success: true });
		}
		if (path === "/api/admin/staging/lose-account") {
			if (!isReadOnlyMode(env)) return new Response("Maintenance mode required", { status: 409 });
			const body = await request.json() as { accountId?: unknown; key?: unknown };
			if (typeof body.accountId !== "string" || !/^\d{16}$/.test(body.accountId) || typeof body.key !== "string") return new Response("Invalid case", { status: 400 });
			if (await env.ACCOUNTS.get(`staging-drill:${body.accountId}`) !== "synthetic-recovery-case") return new Response("Unmarked case", { status: 403 });
			const snapshot = await readAccountBackup(env, body.accountId, body.key);
			if (!snapshot?.auth.user || !snapshot.auth.passkey.length) return new Response("Verified credential backup required", { status: 409 });
			// Deliberately lose roots and credentials, retaining documents and private
			// backup objects. The production restoration path must rediscover the roots.
			const records = accountRecordStore(env);
			for (const prefix of ["account", "shared", "trash"]) await records.delete(`${prefix}:${body.accountId}`);
			await env.AUTH_DB.prepare('DELETE FROM "user" WHERE id = ?').bind(body.accountId).run();
			return Response.json({ success: true, lost: ["account", "shared", "trash", "user", "passkey", "session"] });
		}
		return new Response("Not found", { status: 404 });
	},
};
