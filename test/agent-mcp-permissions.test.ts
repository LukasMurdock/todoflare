import { z } from "zod";
// The agent permission table, end to end: real accounts, shares, trash and
// agent connections, exercised through the MCP endpoint. Each cell's expected
// outcome comes from the same independent oracle as the pure decision table.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { COLUMN_STATES, CONNECTION_STATES, GRANT_STATES, expectedOutcome } from './helpers/agent-access-oracle';
import type { OracleCell } from './helpers/agent-access-oracle';
import { call, callTool, commandRoute, createAgent, MCP_ERAS, mcp, routeForRevoke, seedColumn, setGrant } from './helpers/agent-fixtures';
import type { McpEra } from './helpers/agent-fixtures';
import { createAccount, createColumn } from "./helpers/metadata-fixtures";

type ConnectionState = OracleCell["connection"];
type GrantState = OracleCell["grant"];

const columns = { owned: crypto.randomUUID(), "shared-with-granter": crypto.randomUUID(), "granter-lost-access": crypto.randomUUID(), trashed: crypto.randomUUID(), missing: crypto.randomUUID() };
const SEEDED_ITEM = "seededitem";
const tokens = new Map<string, string | null>();
function tokenFor(connection: ConnectionState, grant: GrantState) {
	const token = tokens.get(`${connection}/${grant}`);
	if (token === undefined) { throw new Error(`Missing ${connection}/${grant} fixture`); }
	return token;
}

beforeAll(async () => {
	const granter = await createAccount();
	const other = await createAccount();

	await createColumn(granter.id, columns["owned"]);
	await createColumn(other.id, columns["shared-with-granter"]);
	await createColumn(other.id, columns["granter-lost-access"]);
	await createColumn(granter.id, columns["trashed"]);
	for (const state of COLUMN_STATES) {
		if (state !== "missing") {await seedColumn(columns[state], [{ id: SEEDED_ITEM, type: "p", children: [{ text: `Column ${state}` }] }]);}
	}
	for (const state of ["shared-with-granter", "granter-lost-access"] as const) {
		expect((await call(other.id, commandRoute("column.share", columns[state]), { targetAccountId: granter.id })).ok).toBe(true);
	}

	for (const connection of CONNECTION_STATES) {
		for (const grant of GRANT_STATES) {
			if (connection === "none") {
				tokens.set(`${connection}/${grant}`, null);
				continue;
			}
			const { agent, token } = await createAgent(granter.id, `${connection}/${grant}`);
			tokens.set(`${connection}/${grant}`, token);
			if (grant !== "none") {
				const level = grant === "expired-edit" ? "edit" : grant;
				for (const state of COLUMN_STATES) {
					if (state === "missing") {continue;}
					expect((await setGrant(granter.id, agent.id, columns[state], { level })).status).toBe(200);
				}
				// A grant can outlive its column, e.g. after a purge; insert it as the store would have.
				await env.AUTH_DB.prepare(
					`INSERT INTO "agent_grant" ("connectionId", "columnId", "level", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0)`,
				)
					.bind(agent.id, columns.missing, level)
					.run();
				if (grant === "expired-edit") {
					await env.AUTH_DB.prepare(`UPDATE "agent_grant" SET "expiresAt" = ? WHERE "connectionId" = ?`).bind(Date.now() - 1, agent.id).run();
				}
			}
			if (connection === "revoked") {expect((await call(granter.id, routeForRevoke(agent.id))).status).toBe(200);}
			if (connection === "expired") {
				await env.AUTH_DB.prepare(`UPDATE "agent_connection" SET "expiresAt" = ? WHERE "id" = ?`).bind(Date.now() - 1, agent.id).run();
			}
		}
	}

	// Access changes after the grants were made.
	expect((await call(other.id, commandRoute("column.revoke", columns["granter-lost-access"]), { targetAccountId: granter.id })).ok).toBe(true);
	expect((await call(granter.id, commandRoute("column.delete", columns.trashed))).ok).toBe(true);
});

// Access must not depend on which protocol revision the agent speaks.
const cells = MCP_ERAS.flatMap(era => CONNECTION_STATES.flatMap(connection =>
	GRANT_STATES.flatMap(grant => COLUMN_STATES.flatMap(column =>
		[false, true].map(readOnlyMode => ({ era, connection, grant, column, required: "read" as const, readOnlyMode })),
	)),
));
const options = (era: McpEra, readOnlyMode: boolean) => ({ era, env: { READ_ONLY_MODE: String(readOnlyMode) } });

describe("MCP permission table: read_column", () => {
	it.each(cells.map((cell) => [`${cell.era} / ${cell.connection} / ${cell.grant} / ${cell.column}${cell.readOnlyMode ? " / read-only" : ""}`, cell] as const))(
		"%s",
		async (_name, cell) => {
			const response = await callTool(tokenFor(cell.connection, cell.grant), "read_column", { columnId: columns[cell.column] }, options(cell.era, cell.readOnlyMode));
			const { outcome } = expectedOutcome(cell);
			const expectedStatus = outcome === "unauthorized" ? 401 : 200;
			const resultType = cell.era === "modern" && expectedStatus === 200 ? "complete" : undefined;
			const expected = {
				unauthorized: { challenge: expect.stringMatching(/^Bearer /) },
				not_found: { result: { isError: true, content: [{ text: "Column not found, or not shared with this agent." }] } },
				allowed: { result: { structuredContent: { markdown: expect.stringContaining(`Column ${cell.column}`) } } },
			};
			if (outcome !== "allowed" && outcome !== "unauthorized" && outcome !== "not_found") {
				throw new Error(`read_column cannot produce ${outcome}`);
			}
			expect(response.status).toBe(expectedStatus);
			expect(response.body?.result?.resultType).toBe(resultType);
			expect(response.body?.result?.isError).toBe(outcome === "not_found" ? true : undefined);
			expect({ result: response.body?.result, challenge: response.headers.get("WWW-Authenticate") }).toMatchObject(expected[outcome]);
		},
	);
});

// Each write tool needs a level; every cell is checked against the oracle with
// that level. The edits are chosen so that allowed cells do not disturb others:
// appends leave the seeded text in place, and the update replaces it with itself.
const WRITE_TOOLS = [
	{ tool: "append_items", required: "append" as const, args: { items: [{ text: "from the table" }] } },
	{ tool: "update_item", required: "edit" as const, args: { itemId: SEEDED_ITEM, find: "Column", replaceWith: "Column" } },
];

describe.each(WRITE_TOOLS)("MCP permission table: $tool", ({ tool, required, args }) => {
	const writeCells = cells.map((cell) => ({ ...cell, required }));
	it.each(writeCells.map((cell) => [`${cell.era} / ${cell.connection} / ${cell.grant} / ${cell.column}${cell.readOnlyMode ? " / read-only" : ""}`, cell] as const))(
		"%s",
		async (_name, cell) => {
			const response = await callTool(tokenFor(cell.connection, cell.grant), tool, { columnId: columns[cell.column], ...args }, options(cell.era, cell.readOnlyMode));
			const { outcome } = expectedOutcome(cell);
			const expected = {
				unauthorized: { status: 401 },
				not_found: { status: 200, isError: true, text: "Column not found, or not shared with this agent." },
				insufficient_grant: { status: 200, isError: true, text: expect.stringContaining(`does not allow ${required}`) },
				read_only_mode: { status: 200, isError: true, text: expect.stringContaining("read-only") },
				allowed: { status: 200, isError: undefined },
			};
			const result = response.body?.result;
			expect({ status: response.status, isError: result?.isError, text: result?.content?.[0]?.text }).toMatchObject(expected[outcome]);
		},
	);
});

describe("MCP permission table: list_columns", () => {
	const listCells = MCP_ERAS.flatMap((era) =>
		CONNECTION_STATES.flatMap((connection) =>
			GRANT_STATES.flatMap((grant) => [false, true].map((readOnlyMode) => ({ era, connection, grant, readOnlyMode }))),
		),
	);
	const unavailable = listCells.filter(cell => cell.connection !== "active");
	it.each(unavailable)("rejects $era / $connection / $grant / $readOnlyMode", async ({ era, connection, grant, readOnlyMode }) => {
		const response = await callTool(tokenFor(connection, grant), "list_columns", {}, options(era, readOnlyMode));
		expect(response.status).toBe(401);
	});
	it.each(listCells.filter(cell => cell.connection === "active").map((cell) => [`${cell.era} / ${cell.connection} / ${cell.grant}${cell.readOnlyMode ? " / read-only" : ""}`, cell] as const))(
		"%s",
		async (_name, { era, connection, grant, readOnlyMode }) => {
			const response = await callTool(tokenFor(connection, grant), "list_columns", {}, options(era, readOnlyMode));
			expect(response.status).toBe(200);
			const visible = COLUMN_STATES.filter(
				(column) => expectedOutcome({ connection, grant, column, required: "read", readOnlyMode }).outcome === "allowed",
			).map((column) => columns[column]);
			const listed = z.array(z.object({ columnId: z.string() })).parse(response.body?.result?.structuredContent?.columns).map((c) => c.columnId);
			expect(new Set(listed)).toEqual(new Set(visible));
		},
	);
});

describe("MCP credentials", () => {
	it.each([
		["no Authorization header", {}],
		["a malformed token", { Authorization: "Bearer nope" }],
		["a well-formed unknown token", { Authorization: `Bearer tfa_${"A".repeat(43)}` }],
		["a non-bearer scheme", { Authorization: `Basic ${btoa("a:b")}` }],
	])("rejects %s", async (_name, headers) => {
		const response = await mcp(null, "tools/list", undefined, { headers });
		expect(response.status).toBe(401);
	});

	it("does not accept a session cookie identity in place of a token", async () => {
		const account = await createAccount();
		const response = await mcp(null, "tools/list", undefined, { headers: { "X-Todoflare-Test-Account": account.id.replaceAll(/\s/g, "") } });
		expect(response.status).toBe(401);
	});
});
