import fs from "node:fs";
import { expect } from "@playwright/test";
import {
	RICH_GUEST_COLUMNS,
	addColumnAndGetId,
	bootstrapSignedInPage,
	createAccount,
	createAgentApi,
	deleteColumnApi,
	enablePublicLinkApi,
	mcpCall,
	openGuestPage,
	registerOAuthConsentUrl,
	settleUi,
	shareColumnApi,
	shortAccountId,
	typeIntoColumn,
	waitForSynced,
} from "./helpers.mjs";

/**
 * Loads a declarative JSON capture spec (`--spec path/to/spec.json`) and
 * converts it into runnable scenarios compatible with `cli.mjs`.
 *
 * Schema:
 * {
 *   "name": "My hill-climb pass",
 *   "scenarios": [
 *     {
 *       "id": "custom-flow",
 *       "title": "Custom Flow",
 *       "category": "custom",
 *       "surface": "ShareMenu",
 *       "description": "Optional notes",
 *       "account": {
 *         "mode": "guest" | "signed-in" | "anonymous",
 *         "welcomed": true,
 *         "dismissModal": true,
 *         "guestColumns": "rich" | null | [...],
 *         "columns": [
 *           { "lines": ["# Title", "[] Item 1"], "publicLink": false, "shareWithPeer": false, "deleteAfter": false }
 *         ],
 *         "agent": { "name": "Claude Code", "grants": [{ "columnIndex": 0, "level": "edit" }], "mcpCalls": [{ "tool": "append_items", "columnIndex": 0, "args": { "items": [{ "text": "From agent" }] } }] },
 *         "oauthConsent": { "clientName": "Claude" },
 *         "offline": false,
 *         "expiredSession": false
 *       },
 *       "route": "/",
 *       "steps": [
 *         { "action": "click", "role": "button", "name": "Share column" },
 *         { "action": "click", "selector": "..." },
 *         { "action": "fill", "role": "textbox", "name": "Account ID", "value": "1234" },
 *         { "action": "type", "text": "Hello" },
 *         { "action": "press", "key": "Escape" },
 *         { "action": "hover", "role": "button", "name": "..." },
 *         { "action": "select", "role": "combobox", "name": "...", "value": "edit" },
 *         { "action": "wait", "ms": 300 },
 *         { "action": "waitForText", "text": "Shared" },
 *         { "action": "goto", "url": "/p/{{publicId}}" },
 *         { "action": "eval", "js": "..." },
 *         { "action": "screenshot", "name": "01-step", "label": "Popover open" }
 *       ]
 *     }
 *   ]
 * }
 */
export function loadSpecScenarios(specPath) {
	const raw = JSON.parse(fs.readFileSync(specPath, "utf8"));
	const list = Array.isArray(raw) ? raw : raw.scenarios;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error(`Spec ${specPath} must contain a non-empty "scenarios" array.`);
	}
	return list.map((def, idx) => {
		const id = def.id ?? `spec-${idx + 1}`;
		const hasStepShots = Array.isArray(def.steps) && def.steps.some((s) => s.action === "screenshot");
		return {
			id,
			title: def.title ?? id,
			category: def.category ?? "custom",
			surface: def.surface ?? "Custom",
			accountConfig: def.accountConfig ?? describeAccount(def.account),
			description: def.description ?? "",
			isFlow: Boolean(def.isFlow ?? hasStepShots),
			async run(env) {
				const { page, context, request, baseURL, captureStep } = env;
				const vars = {};
				const acc = def.account ?? { mode: "guest" };

				if (acc.mode === "guest") {
					const cols =
						acc.guestColumns === undefined || acc.guestColumns === "rich"
							? RICH_GUEST_COLUMNS
							: acc.guestColumns;
					await openGuestPage(page, {
						columns: cols,
						welcomed: acc.welcomed ?? true,
						dismissModal: acc.dismissModal ?? true,
					});
				} else if (acc.mode === "signed-in") {
					const accountId = await createAccount(request, baseURL);
					vars.accountId = accountId;
					vars.shortAccountId = shortAccountId(accountId);
					await bootstrapSignedInPage(page, accountId, { welcomed: acc.welcomed ?? true });

					const colIds = [];
					const colDefs = acc.columns ?? [{ lines: ["# Todoflare", "[] First item"] }];
					for (let ci = 0; ci < colDefs.length; ci++) {
						const cdef = colDefs[ci];
						const colId = await addColumnAndGetId(page);
						colIds.push(colId);
						if (cdef.lines?.length) {
							await typeIntoColumn(page, ci, cdef.lines);
						}
					}
					await waitForSynced(page);

					let needsReload = false;
					for (let ci = 0; ci < colDefs.length; ci++) {
						const cdef = colDefs[ci];
						if (cdef.shareWithPeer) {
							const peerId = await createAccount(request, baseURL);
							vars.peerId = peerId;
							await shareColumnApi(request, baseURL, accountId, colIds[ci], peerId);
							needsReload = true;
						}
						if (cdef.publicLink) {
							const pubId = await enablePublicLinkApi(request, baseURL, accountId, colIds[ci]);
							vars.publicId = pubId;
							needsReload = true;
						}
						if (cdef.deleteAfter) {
							await deleteColumnApi(request, baseURL, accountId, colIds[ci]);
							needsReload = true;
						}
					}

					if (acc.agent) {
						const grants = (acc.agent.grants ?? []).map((g) => ({
							columnId: g.columnId ?? colIds[g.columnIndex ?? 0],
							level: g.level ?? "edit",
						}));
						const created = await createAgentApi(request, baseURL, accountId, {
							name: acc.agent.name ?? "Claude Code",
							expiresInDays: acc.agent.expiresInDays ?? 30,
							grants,
						});
						vars.agentToken = created.token;
						for (const call of acc.agent.mcpCalls ?? []) {
							const columnId = call.columnId ?? colIds[call.columnIndex ?? 0];
							await mcpCall(request, baseURL, created.token, call.tool, {
								columnId,
								...(call.args ?? {}),
							});
						}
						if ((acc.agent.mcpCalls ?? []).length > 0) await page.waitForTimeout(400);
						needsReload = true;
					}

					if (acc.oauthConsent) {
						vars.oauthConsentUrl = await registerOAuthConsentUrl(request, baseURL, {
							clientName: acc.oauthConsent.clientName ?? "Claude",
						});
					}

					if (acc.expiredSession) {
						await page.route("**/api/account", (route) =>
							route.fulfill({
								status: 401,
								contentType: "application/json",
								body: JSON.stringify({ error: "Authentication required", code: "authentication_required" }),
							}),
						);
						needsReload = true;
					}

					if (needsReload && !def.route) {
						await page.reload();
						await page.waitForTimeout(600);
					}

					if (acc.offline) {
						await context.setOffline(true);
					}
				} else if (acc.mode === "anonymous") {
					if (acc.oauthConsent) {
						vars.oauthConsentUrl = await registerOAuthConsentUrl(request, baseURL, {
							clientName: acc.oauthConsent.clientName ?? "Claude",
						});
					}
				}

				if (def.route) {
					await page.goto(interpolate(def.route, vars));
					await settleUi(page);
				}

				for (const step of def.steps ?? []) {
					await executeStep(page, step, vars, captureStep);
				}
				await settleUi(page, { hideToasts: def.hideToasts ?? true });
			},
		};
	});
}

function describeAccount(acc) {
	if (!acc) return "Guest";
	const parts = [acc.mode ?? "guest"];
	if (acc.columns?.length) parts.push(`${acc.columns.length} col(s)`);
	if (acc.agent) parts.push(`agent: ${acc.agent.name ?? "Claude Code"}`);
	if (acc.offline) parts.push("offline");
	if (acc.expiredSession) parts.push("session expired");
	return parts.join(" · ");
}

function interpolate(str, vars) {
	return String(str).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function locate(page, step, vars) {
	if (step.role) {
		const opts = {};
		if (step.name != null) opts.name = interpolate(step.name, vars);
		if (step.exact != null) opts.exact = step.exact;
		const loc = page.getByRole(step.role, opts);
		return step.nth != null ? loc.nth(step.nth) : loc.first();
	}
	if (step.testId) return page.getByTestId(interpolate(step.testId, vars)).first();
	if (step.text) return page.getByText(interpolate(step.text, vars)).first();
	if (step.selector) return page.locator(interpolate(step.selector, vars)).first();
	throw new Error(`Step action "${step.action}" needs role, testId, text, or selector.`);
}

async function executeStep(page, step, vars, captureStep) {
	switch (step.action) {
		case "click":
			await locate(page, step, vars).click();
			break;
		case "hover":
			await locate(page, step, vars).hover();
			break;
		case "fill":
			await locate(page, step, vars).fill(interpolate(step.value ?? "", vars));
			break;
		case "select":
			await locate(page, step, vars).selectOption(interpolate(step.value ?? "", vars));
			break;
		case "type":
			await page.keyboard.type(interpolate(step.text ?? "", vars), { delay: step.delay ?? 8 });
			break;
		case "press":
			await page.keyboard.press(step.key);
			break;
		case "wait":
			await page.waitForTimeout(step.ms ?? 300);
			break;
		case "waitForText":
			await expect(page.getByText(interpolate(step.text, vars)).first()).toBeVisible({ timeout: step.timeout ?? 15000 });
			break;
		case "goto":
			await page.goto(interpolate(step.url, vars));
			await settleUi(page);
			break;
		case "eval":
			await page.evaluate(new Function(step.js));
			break;
		case "screenshot":
			await settleUi(page);
			await captureStep(step.name, step.label ?? step.name);
			break;
		default:
			throw new Error(`Unknown spec step action: "${step.action}"`);
	}
}
