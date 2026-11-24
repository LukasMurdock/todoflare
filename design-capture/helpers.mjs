import { createHash, randomBytes } from "node:crypto";
import { expect } from "@playwright/test";

export const ACCOUNT_STORAGE_KEY = "todoflare-account";
export const WELCOME_KEY = "todoflare-welcomed";
export const LOCAL_COLUMNS_KEY = "todoflare-columns";

export const VIEWPORT_PRESETS = {
	desktop: { width: 1280, height: 800 },
	laptop: { width: 1440, height: 900 },
	tablet: { width: 834, height: 1194 },
	mobile: { width: 390, height: 844 },
};

export function parseViewport(spec) {
	if (VIEWPORT_PRESETS[spec]) {
		return { name: spec, ...VIEWPORT_PRESETS[spec] };
	}
	const match = /^(\d+)x(\d+)$/i.exec(spec);
	if (!match) {
		throw new Error(
			`Invalid viewport "${spec}". Use one of (${Object.keys(VIEWPORT_PRESETS).join(", ")}) or WxH (e.g. 1024x768).`,
		);
	}
	return { name: spec, width: Number(match[1]), height: Number(match[2]) };
}

const text = (value) => [{ text: value }];

/** Rich deterministic guest fixture showcasing every block type the board renders. */
export const RICH_GUEST_COLUMNS = [
	{
		id: "00000000-0000-4000-8000-00000000000a",
		value: [
			{ type: "h1", children: text("Launch Checklist") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: text("Write changelog") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: text("Ship og:image & og:video") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: false, children: text("Record 60s walkthrough") },
			{ type: "p", listStyleType: "todo", indent: 2, checked: false, children: text("Include agent undo diff") },
			{ type: "h2", children: text("Notes") },
			{ type: "p", listStyleType: "disc", indent: 1, children: text("Local-first, works with no account") },
			{ type: "p", listStyleType: "decimal", indent: 1, children: text("Passkeys only, no passwords") },
			{ type: "p", listStyleType: "decimal", indent: 1, listStart: 2, children: text("Per-column MCP grants") },
			{ type: "h3", children: text("Links") },
			{ type: "p", children: text("See todo.tamesystems.org for details") },
		],
	},
	{
		id: "00000000-0000-4000-8000-00000000000b",
		value: [
			{ type: "h1", children: text("Groceries") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: text("Milk") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: false, children: text("Bread") },
			{ type: "p", listStyleType: "todo", indent: 2, checked: false, children: text("Sourdough") },
			{ type: "p", listStyleType: "todo", indent: 1, checked: false, children: text("Espresso beans") },
		],
	},
	{
		id: "00000000-0000-4000-8000-00000000000c",
		collapsed: true,
		value: [{ type: "h1", children: text("Backlog") }],
	},
	{
		id: "00000000-0000-4000-8000-00000000000d",
		value: [{ type: "p", children: text("") }],
	},
];

export function shortAccountId(accountId) {
	const compact = accountId.replace(/\D/g, "");
	return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

export function formatAccountId(accountId) {
	const compact = accountId.replace(/\D/g, "");
	return compact.replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function accountHeaders(accountId) {
	return { "X-Todoflare-Test-Account": accountId.replace(/\D/g, "") };
}

/** Deterministic IP generator per run so rate limits never collide. */
let ipCounter = 11;
function nextSyntheticIp() {
	const a = Math.floor(ipCounter / 200) % 200 + 1;
	const b = (ipCounter % 200) + 10;
	ipCounter += 1;
	return `10.99.${a}.${b}`;
}

export async function createAccount(request, baseURL) {
	const response = await request.post(`${baseURL}/api/account`, {
		headers: { "X-Forwarded-For": nextSyntheticIp() },
	});
	if (!response.ok()) {
		throw new Error(`Failed to create account (${response.status()}): ${await response.text()}`);
	}
	const data = await response.json();
	return data.account.id;
}

export async function createColumnApi(request, baseURL, accountId) {
	const response = await request.post(`${baseURL}/api/column`, {
		headers: { "Content-Type": "application/json", ...accountHeaders(accountId) },
		data: {},
	});
	if (!response.ok()) {
		throw new Error(`Failed to create column (${response.status()}): ${await response.text()}`);
	}
	const payload = await response.json();
	return payload.column.id;
}

export async function shareColumnApi(request, baseURL, ownerId, columnId, targetAccountId) {
	const response = await request.post(`${baseURL}/api/column/${columnId}/share`, {
		headers: {
			"Content-Type": "application/json",
			"X-Idempotency-Key": `share-${columnId}-${Date.now()}-${Math.random()}`,
			...accountHeaders(ownerId),
		},
		data: { targetAccountId: targetAccountId.replace(/\D/g, "") },
	});
	if (!response.ok()) {
		throw new Error(`Failed to share column (${response.status()}): ${await response.text()}`);
	}
	return response.json();
}

export async function enablePublicLinkApi(request, baseURL, ownerId, columnId) {
	const response = await request.post(`${baseURL}/api/column/${columnId}/public`, {
		headers: {
			"Content-Type": "application/json",
			"X-Idempotency-Key": `pub-${columnId}-${Date.now()}-${Math.random()}`,
			...accountHeaders(ownerId),
		},
		data: {},
	});
	if (!response.ok()) {
		throw new Error(`Failed to enable public link (${response.status()}): ${await response.text()}`);
	}
	const payload = await response.json();
	return payload.publicId ?? payload.column?.publicId;
}

export async function deleteColumnApi(request, baseURL, ownerId, columnId) {
	const response = await request.delete(`${baseURL}/api/column/${columnId}`, {
		headers: {
			"X-Idempotency-Key": `del-${columnId}-${Date.now()}-${Math.random()}`,
			...accountHeaders(ownerId),
		},
	});
	if (!response.ok()) {
		throw new Error(`Failed to delete column (${response.status()}): ${await response.text()}`);
	}
}

export async function createAgentApi(request, baseURL, accountId, { name = "Claude Code", expiresInDays = 30, grants = [] } = {}) {
	const response = await request.post(`${baseURL}/api/agents`, {
		headers: { "Content-Type": "application/json", ...accountHeaders(accountId) },
		data: { name, expiresInDays, grants },
	});
	if (!response.ok()) {
		throw new Error(`Failed to create agent (${response.status()}): ${await response.text()}`);
	}
	return response.json();
}

export async function mcpCall(request, baseURL, token, name, args) {
	const response = await request.post(`${baseURL}/api/mcp`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
	});
	if (response.status() !== 200) {
		throw new Error(`MCP call ${name} failed (${response.status()}): ${await response.text()}`);
	}
	return (await response.json()).result;
}

export async function registerOAuthConsentUrl(request, baseURL, { clientName = "Claude", redirectUri = "http://127.0.0.1:33418/callback" } = {}) {
	const challenge401 = await request.post(`${baseURL}/api/mcp`, { data: {} });
	const wwwAuth = challenge401.headers()["www-authenticate"] ?? "";
	const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
	if (!resourceMetadataUrl) {
		throw new Error(`Could not discover OAuth resource metadata from /api/mcp (status ${challenge401.status()})`);
	}
	const resourceMeta = await (await request.get(resourceMetadataUrl)).json();
	const issuer = resourceMeta.authorization_servers[0];
	const metadata = await (await request.get(`${issuer}/.well-known/oauth-authorization-server`)).json();
	const registration = await request.post(metadata.registration_endpoint, {
		headers: { "X-Forwarded-For": nextSyntheticIp() },
		data: {
			client_name: clientName,
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
		},
	});
	if (!registration.ok()) {
		throw new Error(`OAuth DCR failed (${registration.status()}): ${await registration.text()}`);
	}
	const { client_id: clientId } = await registration.json();
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const authorize = new URL(metadata.authorization_endpoint);
	for (const [key, value] of Object.entries({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "design-capture-state",
		resource: `${baseURL}/api/mcp`,
	})) {
		authorize.searchParams.set(key, value);
	}
	return authorize.toString();
}

/** Applies light/dark theme cleanly before hydration and after navigation. */
export async function applyThemeInitScript(context, theme) {
	await context.addInitScript((mode) => {
		const apply = () => {
			if (!document.documentElement) return;
			document.documentElement.classList.toggle("dark", mode === "dark");
		};
		apply();
		document.addEventListener("DOMContentLoaded", apply);
	}, theme);
}

/** Creates a Playwright context configured for crisp deterministic design capture. */
export async function createCaptureContext(browser, { baseURL, viewport, theme = "light", dpr = 1, recordVideoDir = null }) {
	const options = {
		baseURL,
		viewport: { width: viewport.width, height: viewport.height },
		deviceScaleFactor: dpr,
		colorScheme: theme,
		locale: "en-US",
		timezoneId: "UTC",
	};
	if (recordVideoDir) {
		options.recordVideo = { dir: recordVideoDir, size: { width: viewport.width, height: viewport.height } };
	}
	const context = await browser.newContext(options);
	await applyThemeInitScript(context, theme);
	return context;
}

/** Attaches lightweight diagnostics listeners to a page for the review feed. */
export function attachDiagnostics(page) {
	const diag = { consoleErrors: [], pageErrors: [], failedRequests: [] };
	page.on("console", (msg) => {
		if (msg.type() === "error") diag.consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => {
		diag.pageErrors.push(err.message ?? String(err));
	});
	page.on("requestfailed", (req) => {
		const errText = req.failure()?.errorText ?? "failed";
		// Ignore expected intentional aborts or offline-mode cancellations.
		if (!/ERR_ABORTED|ERR_INTERNET_DISCONNECTED/i.test(errText)) {
			diag.failedRequests.push(`${req.method()} ${req.url()} (${errText})`);
		}
	});
	return diag;
}

/** Collects layout telemetry from the live DOM right before capturing a screenshot. */
export async function collectLayoutDiagnostics(page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		const body = document.body;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const scrollWidth = Math.max(root.scrollWidth, body?.scrollWidth ?? 0);
		const scrollHeight = Math.max(root.scrollHeight, body?.scrollHeight ?? 0);
		// Check if any dialog/popover overflows or hugs the viewport edge (<12px margin).
		const floating = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]'));
		const clippedPopups = [];
		const edgeHuggingDialogs = [];
		for (const el of floating) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const role = el.getAttribute("role") ?? "popover";
			if (r.left < -2 || r.top < -2 || r.right > vw + 2 || r.bottom > vh + 2) {
				clippedPopups.push({
					role,
					rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
				});
			}
			if ((role === "dialog" || role === "alertdialog") && (r.left < 12 || vw - r.right < 12)) {
				edgeHuggingDialogs.push({
					role,
					leftGap: Math.round(r.left),
					rightGap: Math.round(vw - r.right),
				});
			}
		}
		// Check fixed-element overlaps: welcome pills vs welcome card, AccountBadge vs column headers.
		const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
		const fixedOverlaps = [];
		const welcomeCard = document.querySelector("[data-welcome-card]");
		if (welcomeCard) {
			const cr = welcomeCard.getBoundingClientRect();
			for (const pill of document.querySelectorAll(".fixed.rounded-full")) {
				if (welcomeCard.contains(pill)) continue;
				const pr = pill.getBoundingClientRect();
				if (pr.width > 0 && pr.height > 0 && rectsOverlap(cr, pr)) {
					fixedOverlaps.push({ a: "welcome-card", b: pill.textContent?.trim() ?? "pill" });
				}
			}
		}
		const badge = document.querySelector("[data-account-badge]");
		if (badge) {
			const br = badge.getBoundingClientRect();
			for (const target of document.querySelectorAll('[data-board-part="add-column"], [data-column-id] .h-10')) {
				const tr = target.getBoundingClientRect();
				if (tr.width > 0 && tr.height > 0 && rectsOverlap(br, tr)) {
					fixedOverlaps.push({ a: "account-badge", b: target.getAttribute("data-board-part") ?? "column-header" });
				}
			}
		}
		return {
			viewport: { width: vw, height: vh },
			scrollWidth,
			scrollHeight,
			horizontalOverflowPx: Math.max(0, scrollWidth - vw),
			clippedPopups,
			edgeHuggingDialogs,
			fixedOverlaps,
			themeClass: root.classList.contains("dark") ? "dark" : "light",
			urlPath: window.location.pathname + (window.location.search ? "?…" : ""),
		};
	});
}

export async function openGuestPage(page, { columns = RICH_GUEST_COLUMNS, welcomed = true, dismissModal = true } = {}) {
	await page.addInitScript(
		({ columnsKey, welcomeKey, cols, isWelcomed }) => {
			if (cols) localStorage.setItem(columnsKey, JSON.stringify(cols));
			else localStorage.removeItem(columnsKey);
			if (isWelcomed) localStorage.setItem(welcomeKey, "true");
			else localStorage.removeItem(welcomeKey);
		},
		{ columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY, cols: columns, isWelcomed: welcomed },
	);
	await page.goto("/");
	// Radix Dialog marks the background board aria-hidden while the onboarding
	// AccountModal or ClaimDataModal is open, so wait for the dialog first.
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 15000 });
	if (dismissModal) {
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden({ timeout: 5000 });
		await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toBeVisible({ timeout: 15000 });
	}
	await settleUi(page);
}

export async function bootstrapSignedInPage(page, accountId, { welcomed = true } = {}) {
	await page.addInitScript(
		({ accountStorageKey, localColumnsKey, welcomeKey, id, isWelcomed }) => {
			localStorage.setItem(accountStorageKey, id);
			if (isWelcomed) localStorage.setItem(welcomeKey, "true");
			else localStorage.removeItem(welcomeKey);
			localStorage.removeItem(localColumnsKey);
		},
		{
			accountStorageKey: ACCOUNT_STORAGE_KEY,
			localColumnsKey: LOCAL_COLUMNS_KEY,
			welcomeKey: WELCOME_KEY,
			id: accountId,
			isWelcomed: welcomed,
		},
	);
	await page.goto("/");
	await expect(page.getByRole("button", { name: "Add column" })).toBeVisible({ timeout: 15000 });
	await settleUi(page);
}

export async function addColumnAndGetId(page) {
	const createResponsePromise = page.waitForResponse(
		(response) => response.request().method() === "POST" && response.url().endsWith("/api/column"),
	);
	await page.getByRole("button", { name: "Add column" }).click();
	const createResponse = await createResponsePromise;
	if (!createResponse.ok()) {
		throw new Error(`Failed to create column: ${await createResponse.text()}`);
	}
	const payload = await createResponse.json();
	await expect(page.getByRole("button", { name: "Collapse column" }).first()).toBeVisible({ timeout: 15000 });
	return payload.column.id;
}

export async function typeIntoColumn(page, columnIndex, lines) {
	const editor = page.getByRole("textbox", { name: "Todo editor" }).nth(columnIndex);
	await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
	await editor.click();
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line.startsWith("{tab}")) {
			await page.keyboard.press("Tab");
			line = line.slice("{tab}".length);
		} else if (line.startsWith("{shift+tab}")) {
			await page.keyboard.press("Shift+Tab");
			line = line.slice("{shift+tab}".length);
		}
		if (line.length > 0) {
			await page.keyboard.type(line, { delay: 4 });
		}
		if (i < lines.length - 1) await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(350);
}

export async function waitForSynced(page) {
	// Wait briefly for WebSocket Yjs frames & IndexedDB outbox to flush cleanly.
	await page.waitForTimeout(450);
}

export async function settleUi(page, { hideToasts = false } = {}) {
	if (hideToasts) {
		await page.addStyleTag({ content: "[data-sonner-toaster] { display: none !important; }" });
	}
	await page.evaluate(() => document.fonts?.ready);
	await page.waitForTimeout(220);
}

export async function blurFocus(page) {
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
}
