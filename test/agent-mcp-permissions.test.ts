// The agent permission table, end to end: real accounts, shares, trash and
// agent connections, exercised through the MCP endpoint. Each cell's expected
// outcome comes from the same independent oracle as the pure decision table.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
	COLUMN_STATES,
	CONNECTION_STATES,
	GRANT_STATES,
	expectedOutcome,
	type OracleCell,
} from "./helpers/agent-access-oracle";
import {
	call,
	callTool,
	commandRoute,
	createAgent,
	MCP_ERAS,
	mcp,
	type McpEra,
	routeForRevoke,
	seedColumn,
	setGrant,
} from "./helpers/agent-fixtures";
import { createAccount, createColumn } from "./helpers/metadata-fixtures";

type ConnectionState = OracleCell["connection"];
type GrantState = OracleCell["grant"];
type ColumnState = OracleCell["column"];

const columns = {} as Record<ColumnState, string>;
const tokens = {} as Record<ConnectionState, Record<GrantState, string | null>>;

beforeAll(async () => {
	const granter = await createAccount();
	const other = await createAccount();

	columns.owned = await createColumn(granter.id);
	columns["shared-with-granter"] = await createColumn(other.id);
	columns["granter-lost-access"] = await createColumn(other.id);
	columns.trashed = await createColumn(granter.id);
	columns.missing = crypto.randomUUID();
	for (const state of COLUMN_STATES) {
		if (state !== "missing") await seedColumn(columns[state], [{ id: `id${state.length}xxxxxx`, type: "p", children: [{ text: `Column ${state}` }] }]);
	}
	for (const state of ["shared-with-granter", "granter-lost-access"] as const) {
		expect((await call(other.id, commandRoute("column.share", columns[state]), { targetAccountId: granter.id })).ok).toBe(true);
	}

	for (const connection of CONNECTION_STATES) {
		tokens[connection] = {} as Record<GrantState, string | null>;
		for (const grant of GRANT_STATES) {
			if (connection === "none") {
				tokens.none[grant] = null;
				continue;
			}
			const { agent, token } = await createAgent(granter.id, `${connection}/${grant}`);
			tokens[connection][grant] = token;
			if (grant !== "none") {
				const level = grant === "expired-edit" ? "edit" : grant;
				for (const state of COLUMN_STATES) {
					if (state === "missing") continue;
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
			if (connection === "revoked") expect((await call(granter.id, routeForRevoke(agent.id))).status).toBe(200);
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
const cells: Array<OracleCell & { era: McpEra }> = [];
for (const era of MCP_ERAS)
	for (const connection of CONNECTION_STATES)
		for (const grant of GRANT_STATES)
			for (const column of COLUMN_STATES)
				for (const readOnlyMode of [false, true]) cells.push({ era, connection, grant, column, required: "read", readOnlyMode });

const options = (era: McpEra, readOnlyMode: boolean) => ({ era, ...(readOnlyMode ? { env: { READ_ONLY_MODE: "true" } } : {}) });

describe("MCP permission table: read_column", () => {
	it.each(cells.map((cell) => [`${cell.era} / ${cell.connection} / ${cell.grant} / ${cell.column}${cell.readOnlyMode ? " / read-only" : ""}`, cell] as const))(
		"%s",
		async (_name, cell) => {
			const response = await callTool(tokens[cell.connection][cell.grant], "read_column", { columnId: columns[cell.column] }, options(cell.era, cell.readOnlyMode));
			const { outcome } = expectedOutcome(cell);
			if (outcome !== "unauthorized") {
				// Proves each era took its own path: only modern results carry resultType.
				expect(response.body?.result?.resultType).toBe(cell.era === "modern" ? "complete" : undefined);
			}
			switch (outcome) {
				case "unauthorized":
					expect(response.status).toBe(401);
					expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer /);
					break;
				case "not_found":
					expect(response.status).toBe(200);
					expect(response.body?.result).toMatchObject({ isError: true, content: [{ text: "Column not found, or not shared with this agent." }] });
					break;
				case "allowed":
					expect(response.status).toBe(200);
					expect(response.body?.result?.isError).toBeUndefined();
					expect(response.body?.result?.structuredContent).toMatchObject({ markdown: expect.stringContaining(`Column ${cell.column}`) });
					break;
				default:
					throw new Error(`read_column cannot produce ${outcome}`);
			}
		},
	);
});

describe("MCP permission table: list_columns", () => {
	const listCells = MCP_ERAS.flatMap((era) =>
		CONNECTION_STATES.flatMap((connection) =>
			GRANT_STATES.flatMap((grant) => [false, true].map((readOnlyMode) => ({ era, connection, grant, readOnlyMode }))),
		),
	);
	it.each(listCells.map((cell) => [`${cell.era} / ${cell.connection} / ${cell.grant}${cell.readOnlyMode ? " / read-only" : ""}`, cell] as const))(
		"%s",
		async (_name, { era, connection, grant, readOnlyMode }) => {
			const response = await callTool(tokens[connection][grant], "list_columns", {}, options(era, readOnlyMode));
			if (connection !== "active") {
				expect(response.status).toBe(401);
				return;
			}
			const visible = COLUMN_STATES.filter(
				(column) => expectedOutcome({ connection, grant, column, required: "read", readOnlyMode }).outcome === "allowed",
			).map((column) => columns[column]);
			const listed = (response.body?.result?.structuredContent?.columns as Array<{ columnId: string }>).map((c) => c.columnId);
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
		const response = await mcp(null, "tools/list", undefined, { headers: { "X-Todoflare-Test-Account": account.id.replace(/\s/g, "") } });
		expect(response.status).toBe(401);
	});
});
