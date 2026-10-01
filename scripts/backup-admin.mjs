#!/usr/bin/env node

const [, , action, columnId, arg3, arg4] = process.argv;

if (!action || (action !== "status" && !columnId)) {
	printUsage();
	process.exit(1);
}

const origin = process.env.BACKUP_API_ORIGIN;
const token = process.env.BACKUP_ADMIN_TOKEN;

if (!origin || !token) {
	console.error("Missing BACKUP_API_ORIGIN or BACKUP_ADMIN_TOKEN");
	process.exit(1);
}

let responseIndicatesFailure = false;
const baseHeaders = {
	Authorization: `Bearer ${token}`,
};

try {
	if (action === "status") {
		const res = await fetch(`${origin}/api/admin/backups/status`, { headers: baseHeaders });
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}
	if (action === "create-account") {
		const res = await fetch(`${origin}/api/admin/backups/account`, { method: "POST", headers: { ...baseHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ accountId: columnId, ...(arg3 ? { key: arg3 } : {}) }) });
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}
	if (action === "list") {
		const res = await fetch(
			`${origin}/api/admin/backups/column/${encodeURIComponent(columnId)}`,
			{ headers: baseHeaders },
		);
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}

	if (action === "create") {
		const res = await fetch(
			`${origin}/api/admin/backups/column/${encodeURIComponent(columnId)}`,
			{ method: "POST", headers: baseHeaders },
		);
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}

	if (action === "restore") {
		const key = arg3 && arg3 !== "in_place" && arg3 !== "clone" ? arg3 : undefined;
		const mode = arg4 ?? (arg3 === "in_place" || arg3 === "clone" ? arg3 : undefined);
		const body = {
			...(key ? { key } : {}),
			...(mode ? { mode } : {}),
		};
		const res = await fetch(
			`${origin}/api/admin/backups/column/${encodeURIComponent(columnId)}/restore`,
			{
				method: "POST",
				headers: {
					...baseHeaders,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}

	if (action === "restore-account") {
		const res = await fetch(`${origin}/api/admin/backups/account/restore`, {
			method: "POST",
			headers: { ...baseHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({ accountId: columnId, ...(arg3 ? { key: arg3 } : {}) }),
		});
		await printResponse(res);
		process.exit(res.ok && !responseIndicatesFailure ? 0 : 1);
	}

	printUsage();
	process.exit(1);
} catch (error) {
	console.error(error);
	process.exit(1);
}

function printUsage() {
	console.error(
		[
			"Usage:",
			"  BACKUP_API_ORIGIN=https://... BACKUP_ADMIN_TOKEN=... node scripts/backup-admin.mjs list <columnId>",
			"  BACKUP_API_ORIGIN=https://... BACKUP_ADMIN_TOKEN=... node scripts/backup-admin.mjs create <columnId>",
			"  BACKUP_API_ORIGIN=https://... BACKUP_ADMIN_TOKEN=... node scripts/backup-admin.mjs restore <columnId> [key] [clone|in_place]",
			"  BACKUP_API_ORIGIN=https://... BACKUP_ADMIN_TOKEN=... node scripts/backup-admin.mjs restore-account <accountId> [accountBackupKey]",
			"  node scripts/backup-admin.mjs create-account <accountId>",
			"  node scripts/backup-admin.mjs status",
			"  Default restore mode is clone",
		].join("\n"),
	);
}

async function printResponse(res) {
	const text = await res.text();
	let parsed = null;

	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}

	responseIndicatesFailure = parsed !== null && typeof parsed === "object" && parsed.success === false;
	console.log(JSON.stringify({ status: res.status, body: parsed }, null, 2));
}
