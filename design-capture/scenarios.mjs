import { expect } from "@playwright/test";
import {
	RICH_GUEST_COLUMNS,
	addColumnAndGetId,
	blurFocus,
	bootstrapSignedInPage,
	createAccount,
	createAgentApi,
	createCaptureContext,
	deleteColumnApi,
	enablePublicLinkApi,
	formatAccountId,
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
 * Complete registry of Todoflare UI surfaces, states, account configurations,
 * and multi-step flows for design review and iterative hill climbs.
 *
 * Each scenario receives `env`:
 *   { browser, context, page, request, baseURL, viewport, theme, dpr, captureStep(name, meta?) }
 */
export const SCENARIOS = [
	// =========================================================================
	// 1. GUEST & ONBOARDING
	// =========================================================================
	{
		id: "guest-board",
		title: "Guest board (populated)",
		category: "guest",
		surface: "TodoBoard",
		accountConfig: "Guest (localStorage, 4 columns)",
		description: "Rich multi-column guest board: headings, checked/unchecked todos, nested item, bullets, numbered list, links, collapsed & empty columns.",
		async run({ page }) {
			await openGuestPage(page, { columns: RICH_GUEST_COLUMNS, welcomed: true, dismissModal: true });
			await blurFocus(page);
		},
	},
	{
		id: "guest-welcome",
		title: "First-visit welcome overlay",
		category: "guest",
		surface: "WelcomeScreen",
		accountConfig: "Guest (first visit, no existing data)",
		description: "Curved SVG annotation tour anchored to the first column, add-column button, and keyboard shortcuts pill.",
		async run({ page }) {
			await openGuestPage(page, { columns: null, welcomed: false, dismissModal: true });
			await expect(page.getByText("All your data is saved locally in your browser.")).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-account-modal",
		title: "Passkey onboarding modal",
		category: "guest",
		surface: "AccountModal",
		accountConfig: "Guest (no local data)",
		description: "Initial 'Sync with a passkey' dialog shown to a fresh visitor with no saved local columns.",
		async run({ page }) {
			await openGuestPage(page, { columns: null, welcomed: true, dismissModal: false });
			await expect(page.getByRole("heading", { name: "Sync with a passkey" })).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-account-modal-recovery",
		title: "Account recovery code form",
		category: "guest",
		surface: "AccountModal",
		accountConfig: "Guest (recovery form expanded)",
		description: "Emergency recovery code sign-in state inside AccountModal.",
		async run({ page }) {
			await openGuestPage(page, { columns: null, welcomed: true, dismissModal: false });
			await page.getByRole("button", { name: "Use a recovery code" }).click();
			await expect(page.getByRole("textbox", { name: "Recovery code" })).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-claim-data-modal",
		title: "Claim local data modal",
		category: "guest",
		surface: "ClaimDataModal",
		accountConfig: "Guest (has existing local columns)",
		description: "Prompt offering to create a passkey account and claim local columns, start fresh, or sign in.",
		async run({ page }) {
			await openGuestPage(page, { columns: RICH_GUEST_COLUMNS, welcomed: true, dismissModal: false });
			await expect(page.getByRole("heading", { name: "You have local data" })).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-shortcuts-dialog",
		title: "Keyboard shortcuts dialog",
		category: "guest",
		surface: "KeyboardShortcuts",
		accountConfig: "Guest",
		description: "Markdown & keyboard shortcut reference triggered by the bottom-left pill or Cmd+/.",
		async run({ page }) {
			await openGuestPage(page, { columns: RICH_GUEST_COLUMNS, welcomed: true, dismissModal: true });
			await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-delete-confirm",
		title: "Delete column confirmation",
		category: "guest",
		surface: "TodoColumn AlertDialog",
		accountConfig: "Guest (non-empty column)",
		description: "Destructive confirmation dialog when deleting a column that contains content.",
		async run({ page }) {
			await openGuestPage(page, { columns: RICH_GUEST_COLUMNS, welcomed: true, dismissModal: true });
			await page.getByRole("button", { name: "Delete column" }).first().click();
			await expect(page.getByRole("alertdialog")).toBeVisible();
			await settleUi(page);
		},
	},
	{
		id: "guest-storage-recovery",
		title: "Storage recovery banner",
		category: "guest",
		surface: "StorageRecoveryBanner",
		accountConfig: "Guest (localStorage quota failure)",
		description: "Red alert banner shown when browser storage fails to save, offering recovery download and retry.",
		async run({ page }) {
			await openGuestPage(page, { columns: RICH_GUEST_COLUMNS, welcomed: true, dismissModal: true });
			// Trigger a real localStorage quota failure on the next edit.
			await page.evaluate(() => {
				const orig = Storage.prototype.setItem;
				Storage.prototype.setItem = function (k, v) {
					if (k === "todoflare-columns") {
						throw new DOMException("QuotaExceededError", "QuotaExceededError");
					}
					return orig.call(this, k, v);
				};
			});
			const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
			await editor.click();
			await page.keyboard.type(" unsaved edit");
			await expect(page.getByRole("alert")).toContainText("Editing paused");
			await settleUi(page);
		},
	},

	// =========================================================================
	// 2. SIGNED-IN ACCOUNT & SYNC
	// =========================================================================
	{
		id: "signed-in-board",
		title: "Signed-in synced board",
		category: "account",
		surface: "TodoApp (synced)",
		accountConfig: "Signed-in account (owned + shared + agent active)",
		description: "Full synced workspace with owned column, active AI agent dot, shared column badge, and top-right AccountBadge.",
		async run({ page, request, baseURL }) {
			const ownerId = await createAccount(request, baseURL);
			const peerId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, ownerId);
			const col1 = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Product Roadmap", "[] Design hill-climb harness", "[] Real-time Yjs presence", "[] Ship social previews"]);
			const col2 = await addColumnAndGetId(page);
			await typeIntoColumn(page, 1, ["# Groceries", "[] Milk", "[] Bread", "{tab}Sourdough"]);
			await waitForSynced(page);
			// Give an agent access to col2 so the sky-blue active dot appears in the column header.
			await createAgentApi(request, baseURL, ownerId, {
				name: "Claude Code",
				grants: [{ columnId: col2, level: "edit" }],
			});
			// Peer shares a column with owner so a "Shared by ..." column appears on the board.
			const peerCol = await addSharedColumnFromPeer(page.context().browser(), request, baseURL, peerId, ownerId, [
				"# Team Sync",
				"[] Review Q4 milestones",
				"[] Share staging link",
			]);
			void col1;
			void peerCol;
			await page.reload();
			await expect(page.getByText("Product Roadmap")).toBeVisible({ timeout: 15000 });
			await expect(page.getByText("Team Sync")).toBeVisible({ timeout: 15000 });
			await blurFocus(page);
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "account-menu",
		title: "Account dropdown menu",
		category: "account",
		surface: "AccountBadge DropdownMenu",
		accountConfig: "Signed-in account",
		description: "Top-right Account menu showing shareable Account ID, Passkeys & recovery, Agents, Sync Debug Snapshot, Export/Import, Trash, and Build.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Daily Tasks", "[] Review PR #42", "[] Check backups"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await expect(page.getByRole("menuitem", { name: "Agents" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "account-status-tooltip",
		title: "Account sync status tooltip",
		category: "account",
		surface: "AccountBadge Tooltip",
		accountConfig: "Signed-in account (connected realtime)",
		description: "Hover tooltip over the status badge showing Account ID, sync mode, queue depths, hydration time, and browser storage durability.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Synced", "[] Live item"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).hover();
			await expect(page.getByRole("tooltip")).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "credentials-dialog",
		title: "Passkeys and recovery dialog",
		category: "account",
		surface: "CredentialManager",
		accountConfig: "Signed-in account (1 passkey)",
		description: "Credential management modal for adding/removing passkeys, rotating recovery codes, and signing out other sessions.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			// The E2E test-account bypass has no Better Auth session cookie for passkey listing;
			// return a realistic single passkey so the dialog renders its intended state without 401.
			await page.route("**/api/auth/passkey/list-user-passkeys**", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify([{ id: "pk-macbook", name: "MacBook Pro" }]),
				}),
			);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Passkeys and recovery" }).click();
			await expect(page.getByRole("heading", { name: "Passkeys and recovery" })).toBeVisible();
			await expect(page.getByText("MacBook Pro")).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "recently-deleted-empty",
		title: "Recently Deleted (empty)",
		category: "account",
		surface: "RecentlyDeleted Dialog",
		accountConfig: "Signed-in account (no trashed columns)",
		description: "Empty state of the 30-day Recently Deleted trash modal.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: /Recently Deleted/ }).click();
			await expect(page.getByText("No recently deleted columns.")).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "recently-deleted-populated",
		title: "Recently Deleted (with trashed column)",
		category: "account",
		surface: "RecentlyDeleted Dialog",
		accountConfig: "Signed-in account (1 trashed column)",
		description: "Trash modal listing a deleted column with 30-day expiry countdown and Restore button.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			const col2 = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Active Board", "[] Keep this column"]);
			await waitForSynced(page);
			await deleteColumnApi(request, baseURL, accountId, col2);
			await page.reload();
			await expect(page.getByRole("button", { name: shortAccountId(accountId) })).toBeVisible({ timeout: 15000 });
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: /Recently Deleted/ }).click();
			await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "reconnect-banner",
		title: "Session expired reconnect banner",
		category: "account",
		surface: "ReconnectBanner",
		accountConfig: "Signed-in account (401 session expired)",
		description: "Amber alert banner when a passkey session expires while preserving local columns and queued edits.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Offline Safe", "[] Local edits stay intact"]);
			await waitForSynced(page);
			// Simulate an expired passkey session returning 401 on hydration.
			await page.route("**/api/account", (route) =>
				route.fulfill({
					status: 401,
					contentType: "application/json",
					body: JSON.stringify({ error: "Authentication required", code: "authentication_required" }),
				}),
			);
			await page.reload();
			await expect(page.getByText("Sign-in required to resume syncing")).toBeVisible({ timeout: 15000 });
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "offline-syncing",
		title: "Offline mode with queued edits",
		category: "account",
		surface: "TodoApp (offline)",
		accountConfig: "Signed-in account (network offline)",
		description: "Signed-in board working offline: red offline dot in AccountBadge while edits continue locally.",
		async run({ page, context, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Flight Mode", "[] Draft release notes"]);
			await waitForSynced(page);
			await context.setOffline(true);
			await typeIntoColumn(page, 0, ["[] Written while offline"]);
			await page.waitForTimeout(450);
			await page.getByRole("button", { name: shortAccountId(accountId) }).hover();
			await settleUi(page, { hideToasts: true });
		},
	},

	// =========================================================================
	// 3. SHARING, COLLABORATION & PUBLIC LINKS
	// =========================================================================
	{
		id: "share-menu-private",
		title: "Share popover (private column)",
		category: "sharing",
		surface: "ShareMenu",
		accountConfig: "Signed-in owner (unshared)",
		description: "Default ShareMenu popover with Account ID input and Enable public link button.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Sprint Goals", "[] Finalize API contracts"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: "Share column" }).click();
			await expect(page.getByRole("textbox", { name: "Account ID" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "share-menu-shared-and-public",
		title: "Share popover (collaborator + public link)",
		category: "sharing",
		surface: "ShareMenu",
		accountConfig: "Signed-in owner (1 collaborator + public link)",
		description: "Populated ShareMenu showing active collaborator with revoke button and enabled public URL with Copy / Regenerate / Disable.",
		async run({ page, request, baseURL }) {
			const ownerId = await createAccount(request, baseURL);
			const peerId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, ownerId);
			const colId = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Shared Spec", "[] Review architecture", "[] Publish link"]);
			await waitForSynced(page);
			await shareColumnApi(request, baseURL, ownerId, colId, peerId);
			await enablePublicLinkApi(request, baseURL, ownerId, colId);
			await page.reload();
			await expect(page.getByText("Shared Spec")).toBeVisible({ timeout: 15000 });
			await page.getByRole("button", { name: "Share column" }).click();
			await expect(page.getByRole("button", { name: "Disable" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "collaborative-live-presence",
		title: "Live multiplayer presence & cursor",
		category: "sharing",
		surface: "PresenceAvatars + RemoteCursorOverlay",
		accountConfig: "2 signed-in accounts editing same column",
		description: "Two concurrent browser sessions editing the same shared column, displaying live PresenceAvatars dot and remote Yjs cursor.",
		async run({ browser, page, request, baseURL, viewport, theme, dpr }) {
			const ownerId = await createAccount(request, baseURL);
			const peerId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, ownerId);
			const colId = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Live Jam", "[] Pick typography scale", "[] Audit contrast"]);
			await waitForSynced(page);
			await shareColumnApi(request, baseURL, ownerId, colId, peerId);

			const peerContext = await createCaptureContext(browser, { baseURL, viewport, theme, dpr });
			try {
				const peerPage = await peerContext.newPage();
				await bootstrapSignedInPage(peerPage, peerId);
				const peerEditor = peerPage.getByRole("textbox", { name: "Todo editor" }).first();
				await expect(peerEditor).toContainText("Live Jam", { timeout: 15000 });
				await peerEditor.click();
				await peerPage.keyboard.press("End");
				await peerPage.waitForTimeout(500);
				await page.waitForTimeout(500);
				await settleUi(page, { hideToasts: true });
			} finally {
				await peerContext.close();
			}
		},
	},
	{
		id: "public-view",
		title: "Public read-only column page",
		category: "sharing",
		surface: "PublicView",
		accountConfig: "Anonymous viewer (/p/:publicId)",
		description: "Read-only public link view rendering static rich-text ColumnSnapshot with Todoflare header.",
		async run({ page, browser, request, baseURL, viewport, theme, dpr }) {
			const ownerId = await createAccount(request, baseURL);
			const setupCtx = await createCaptureContext(browser, { baseURL, viewport, theme, dpr });
			let publicId;
			try {
				const setupPage = await setupCtx.newPage();
				await bootstrapSignedInPage(setupPage, ownerId);
				const colId = await addColumnAndGetId(setupPage);
				await typeIntoColumn(setupPage, 0, [
					"# Weekend Packing List",
					"[] Passport & charger",
					"[] Rain jacket",
					"[] Camera film",
					"## Notes",
					"- Flight leaves at 7:40 AM",
				]);
				await waitForSynced(setupPage);
				publicId = await enablePublicLinkApi(request, baseURL, ownerId, colId);
			} finally {
				await setupCtx.close();
			}
			await page.goto(`/p/${publicId}`);
			await expect(page.getByText("Weekend Packing List")).toBeVisible({ timeout: 15000 });
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "public-view-error",
		title: "Public view not found / error",
		category: "sharing",
		surface: "PublicView (error)",
		accountConfig: "Anonymous viewer (invalid /p/:id)",
		description: "Error screen when visiting a revoked or nonexistent public column link.",
		async run({ page }) {
			await page.goto("/p/notfound");
			await expect(page.getByRole("heading", { name: "Unable to load" })).toBeVisible({ timeout: 15000 });
			await settleUi(page, { hideToasts: true });
		},
	},

	// =========================================================================
	// 4. AI AGENTS & MCP
	// =========================================================================
	{
		id: "agents-dialog-empty",
		title: "Agents dialog (choose app)",
		category: "agents",
		surface: "AgentsDialog (Home - empty)",
		accountConfig: "Signed-in account (0 agents)",
		description: "First-time Agents dialog listing Claude Code, Claude.ai, ChatGPT, and Another app or script.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Inbox", "[] Triage issues"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			await expect(page.getByRole("dialog", { name: "Agents" })).toBeVisible();
			await expect(page.getByText("No agents connected.")).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "agents-setup-claude-code",
		title: "Agents setup: Claude Code",
		category: "agents",
		surface: "AgentsDialog (TokenSetup)",
		accountConfig: "Signed-in account (2 columns)",
		description: "Numbered setup flow for Claude Code with per-column grant picker, name, and expiry selector.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Engineering", "[] Fix flaky test"]);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 1, ["# Personal", "[] Call mom"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			const dialog = page.getByRole("dialog", { name: "Agents" });
			await dialog.getByRole("button", { name: /^Claude Code/ }).click();
			await dialog.getByRole("combobox", { name: "Access to Engineering" }).selectOption("edit");
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "agents-setup-claude-ai",
		title: "Agents setup: Claude.ai",
		category: "agents",
		surface: "AgentsDialog (ClaudeAiSetup)",
		accountConfig: "Signed-in account",
		description: "Guided OAuth connector instructions for Claude.ai with copyable MCP endpoint.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			const dialog = page.getByRole("dialog", { name: "Agents" });
			await dialog.getByRole("button", { name: /^Claude\.ai/ }).click();
			await expect(dialog.getByRole("heading", { name: "Connect Claude.ai" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "agents-setup-chatgpt",
		title: "Agents setup: ChatGPT",
		category: "agents",
		surface: "AgentsDialog (ChatGptSetup)",
		accountConfig: "Signed-in account",
		description: "Guided custom MCP server form for ChatGPT with icon download and copyable fields.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			const dialog = page.getByRole("dialog", { name: "Agents" });
			await dialog.getByRole("button", { name: /^ChatGPT/ }).click();
			await expect(dialog.getByRole("heading", { name: "Connect ChatGPT" })).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "agents-token-created",
		title: "Agents: one-time token & CLI command",
		category: "agents",
		surface: "AgentsDialog (TokenConnected)",
		accountConfig: "Signed-in account (just created token)",
		description: "One-time bearer token reveal with copyable `claude mcp add` command and amber security warning.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Engineering", "[] Ship design capture"]);
			await waitForSynced(page);
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			const dialog = page.getByRole("dialog", { name: "Agents" });
			await dialog.getByRole("button", { name: /^Claude Code/ }).click();
			await dialog.getByRole("combobox", { name: "Access to Engineering" }).selectOption("edit");
			await dialog.getByRole("button", { name: "Connect with 1 column" }).click();
			await expect(dialog.getByTestId("agent-token")).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "agents-dialog-connected",
		title: "Agents dialog (connected agents)",
		category: "agents",
		surface: "AgentsDialog (Home - connected)",
		accountConfig: "Signed-in account (2 agents connected)",
		description: "Connected agents list with per-column grant level dropdowns, '+ Add a column…', and Disconnect controls.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			const col1 = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Engineering", "[] Audit keyboard navigation"]);
			const col2 = await addColumnAndGetId(page);
			await typeIntoColumn(page, 1, ["# Groceries", "[] Oat milk"]);
			await waitForSynced(page);
			await createAgentApi(request, baseURL, accountId, {
				name: "Claude Code",
				grants: [
					{ columnId: col1, level: "edit" },
					{ columnId: col2, level: "read" },
				],
			});
			await createAgentApi(request, baseURL, accountId, {
				name: "Triage Script",
				grants: [],
			});
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			await expect(page.getByTestId("agent-connection").first()).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "column-agents-menu-with-diff",
		title: "Column agents popover + live diff & undo",
		category: "agents",
		surface: "ColumnAgentsMenu + AgentChangeDiff",
		accountConfig: "Signed-in account (agent edited column via MCP)",
		description: "Per-column agent popover showing active grant level, structured Added/Changed diff from a real MCP tool call, and Undo button.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			const colId = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Release Tasks", "[] Draft blog post", "[] Verify migrations"]);
			await waitForSynced(page);
			const created = await createAgentApi(request, baseURL, accountId, {
				name: "Claude Code",
				grants: [{ columnId: colId, level: "edit" }],
			});
			await mcpCall(request, baseURL, created.token, "append_items", {
				columnId: colId,
				items: [{ text: "Run visual hill-climb sweep" }, { text: "Verify og:video loop SSIM" }],
			});
			await page.reload();
			await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("Run visual hill-climb sweep", {
				timeout: 15000,
			});
			await page.getByRole("button", { name: "Agents for this column" }).first().click();
			await expect(page.getByTestId("agent-change").first()).toBeVisible();
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "oauth-consent-signed-in",
		title: "OAuth consent page (signed in)",
		category: "agents",
		surface: "OAuthConsentPage",
		accountConfig: "Signed-in account + registered MCP OAuth client",
		description: "OAuth 2.1 consent card showing unverified client notice, localhost warning, per-column permission picker, expiry, and Allow/Cancel.",
		async run({ page, request, baseURL }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Launch Plan", "[] Ship beta"]);
			await addColumnAndGetId(page);
			await typeIntoColumn(page, 1, ["# Private Notes", "[] Taxes"]);
			await waitForSynced(page);
			const consentUrl = await registerOAuthConsentUrl(request, baseURL, { clientName: "Claude" });
			await page.goto(consentUrl);
			await expect(page.getByTestId("consent-client-name")).toHaveText("Claude wants to use Todoflare");
			await page.getByRole("combobox", { name: "Access to Launch Plan" }).selectOption("edit");
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "oauth-consent-signed-out",
		title: "OAuth consent page (signed out)",
		category: "agents",
		surface: "OAuthConsentPage (signed out)",
		accountConfig: "Signed-out visitor + registered MCP OAuth client",
		description: "OAuth consent card prompting passkey sign-in before selecting columns.",
		async run({ page, request, baseURL }) {
			const consentUrl = await registerOAuthConsentUrl(request, baseURL, { clientName: "Claude" });
			await page.goto(consentUrl);
			await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible({ timeout: 15000 });
			await settleUi(page, { hideToasts: true });
		},
	},
	{
		id: "oauth-consent-invalid",
		title: "OAuth consent page (invalid link)",
		category: "agents",
		surface: "OAuthConsentPage (invalid)",
		accountConfig: "Anonymous visitor (/oauth/authorize without params)",
		description: "Error state when an OAuth authorization link is malformed or missing parameters.",
		async run({ page }) {
			await page.goto("/oauth/authorize");
			await expect(page.getByRole("heading", { name: /can.t continue/ })).toBeVisible({ timeout: 15000 });
			await settleUi(page, { hideToasts: true });
		},
	},

	// =========================================================================
	// 5. MULTI-STEP INTERACTIVE FLOWS (captures filmstrip steps + optional video)
	// =========================================================================
	{
		id: "flow-agent-edit-and-undo",
		title: "Flow: Connect agent → MCP edit → inspect diff → Undo",
		category: "flows",
		surface: "End-to-end Agent Workflow",
		accountConfig: "Signed-in account + live MCP client",
		isFlow: true,
		description: "Full multi-step journey showing board setup, agent connection, live MCP edit landing in the editor, diff inspection, and compare-and-revert undo.",
		async run({ page, request, baseURL, captureStep }) {
			const accountId = await createAccount(request, baseURL);
			await bootstrapSignedInPage(page, accountId);
			const colId = await addColumnAndGetId(page);
			await typeIntoColumn(page, 0, ["# Design Sprint", "[] Audit typography", "[] Tighten spacing"]);
			await waitForSynced(page);
			await captureStep("01-initial-board", "Initial synced column before connecting agent");

			// Connect agent via UI flow
			await page.getByRole("button", { name: shortAccountId(accountId) }).click();
			await page.getByRole("menuitem", { name: "Agents" }).click();
			const dialog = page.getByRole("dialog", { name: "Agents" });
			await dialog.getByRole("button", { name: /^Claude Code/ }).click();
			await dialog.getByRole("combobox", { name: "Access to Design Sprint" }).selectOption("edit");
			await captureStep("02-grant-column", "Granting Edit access to Design Sprint");

			await dialog.getByRole("button", { name: "Connect with 1 column" }).click();
			await expect(dialog.getByTestId("agent-token")).toBeVisible();
			const command = (await dialog.getByTestId("agent-token").locator("code").first().textContent()).trim();
			const token = /Bearer (tfa_[A-Za-z0-9_-]+)"/.exec(command)[1];
			await captureStep("03-token-issued", "One-time setup command issued");

			await dialog.getByRole("button", { name: "Done" }).click();
			await page.keyboard.press("Escape");

			// Real MCP edit arrives live over WebSocket
			await mcpCall(request, baseURL, token, "append_items", {
				columnId: colId,
				items: [{ text: "Check mobile popover clearance" }],
			});
			await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("Check mobile popover clearance", {
				timeout: 15000,
			});
			await captureStep("04-agent-edit-live", "Agent edit arrives live in the column");

			// Open column agents menu and inspect diff
			await page.getByRole("button", { name: "Agents for this column" }).first().click();
			const change = page.getByTestId("agent-change").first();
			await expect(change).toBeVisible();
			await captureStep("05-diff-popover", "Per-column agent change diff with Undo button");

			// Click Undo
			await change.getByRole("button", { name: /^Undo/ }).click();
			await expect(change).toContainText("Undone");
			await captureStep("06-after-undo", "Agent edit cleanly reverted with Undone badge");
		},
	},
];

/** Helper to spin up a brief peer browser session to create & populate a shared column. */
async function addSharedColumnFromPeer(browser, request, baseURL, peerId, targetOwnerId, lines) {
	const peerCtx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
	try {
		const peerPage = await peerCtx.newPage();
		await bootstrapSignedInPage(peerPage, peerId);
		const colId = await addColumnAndGetId(peerPage);
		await typeIntoColumn(peerPage, 0, lines);
		await waitForSynced(peerPage);
		await shareColumnApi(request, baseURL, peerId, colId, targetOwnerId);
		return colId;
	} finally {
		await peerCtx.close();
	}
}
