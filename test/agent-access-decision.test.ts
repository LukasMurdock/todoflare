// The agent permission table. Every combination of credential, grant, column
// state, required level and read-only mode is enumerated and checked against
// an ordered rule table written independently of the implementation. A new
// state must be added to a dimension here before it can be decided.
import { describe, expect, it } from "vitest";
import { AGENT_GRANT_LEVELS } from "../src/lib/api/agent-contract";
import { decideAgentColumnAccess, type AgentAccessFacts } from "../src/server/agent-access/decision";
import {
	COLUMN_STATES,
	CONNECTION_STATES,
	GRANT_STATES,
	ORACLE_RULES,
	expectedOutcome,
	type OracleCell,
	type OracleOutcome,
} from "./helpers/agent-access-oracle";

const NOW = 1_800_000_000_000;
const GRANTER = "1111222233334444";
const OTHER = "5555666677778888";

const CONNECTIONS = {
	none: null,
	active: { userId: GRANTER, expiresAt: NOW + 1, revokedAt: null },
	revoked: { userId: GRANTER, expiresAt: NOW + 1, revokedAt: NOW - 1 },
	// Expiry is exclusive: a credential is dead at the instant it expires.
	expired: { userId: GRANTER, expiresAt: NOW, revokedAt: null },
} satisfies Record<Cell["connection"], AgentAccessFacts["connection"]>;

const GRANTS = {
	none: null,
	read: { level: "read", expiresAt: null },
	append: { level: "append", expiresAt: NOW + 1 },
	edit: { level: "edit", expiresAt: null },
	"expired-edit": { level: "edit", expiresAt: NOW },
} satisfies Record<Cell["grant"], AgentAccessFacts["grant"]>;

const COLUMNS = {
	missing: null,
	owned: { meta: { ownerId: GRANTER, sharedWith: [] }, trashed: false },
	"shared-with-granter": { meta: { ownerId: OTHER, sharedWith: ["1111 2222 3333 4444"] }, trashed: false },
	// The owner revoked the granting account's share after the grant was made.
	"granter-lost-access": { meta: { ownerId: OTHER, sharedWith: [] }, trashed: false },
	trashed: { meta: { ownerId: GRANTER, sharedWith: [] }, trashed: true },
} satisfies Record<Cell["column"], AgentAccessFacts["column"]>;

type Cell = OracleCell;
type Outcome = OracleOutcome;

const cells: Cell[] = [];
for (const connection of CONNECTION_STATES)
	for (const grant of GRANT_STATES)
		for (const column of COLUMN_STATES)
			for (const required of AGENT_GRANT_LEVELS)
				for (const readOnlyMode of [false, true]) cells.push({ connection, grant, column, required, readOnlyMode });

function decide(cell: Cell): Outcome {
	const decision = decideAgentColumnAccess({
		now: NOW,
		readOnlyMode: cell.readOnlyMode,
		connection: CONNECTIONS[cell.connection],
		grant: GRANTS[cell.grant],
		column: COLUMNS[cell.column],
		required: cell.required,
	});
	return decision.allowed ? "allowed" : decision.code;
}

describe("agent permission table", () => {
	it("enumerates every combination", () => {
		expect(cells).toHaveLength(4 * 5 * 5 * 3 * 2);
	});

	it.each(cells.map((cell) => [Object.values(cell).join(" / "), cell] as const))("%s", (_name, cell) => {
		const { rule, outcome } = expectedOutcome(cell);
		expect({ outcome: decide(cell), rule }).toEqual({ outcome, rule });
	});

	it("has no dead rules", () => {
		const used = new Set(cells.map((cell) => expectedOutcome(cell).rule));
		expect(ORACLE_RULES.map(([rule]) => rule).filter((rule) => !used.has(rule))).toEqual([]);
	});

	// Hand-picked rows that state the product guarantees in plain terms, so a
	// mistaken rule table cannot silently agree with a mistaken implementation.
	it.each<[string, Cell, Outcome]>([
		["append never edits", { connection: "active", grant: "append", column: "owned", required: "edit", readOnlyMode: false }, "insufficient_grant"],
		["append adds", { connection: "active", grant: "append", column: "owned", required: "append", readOnlyMode: false }, "allowed"],
		["read cannot append", { connection: "active", grant: "read", column: "owned", required: "append", readOnlyMode: false }, "insufficient_grant"],
		["reads continue in read-only mode", { connection: "active", grant: "read", column: "owned", required: "read", readOnlyMode: true }, "allowed"],
		["edit works on columns shared with me", { connection: "active", grant: "edit", column: "shared-with-granter", required: "edit", readOnlyMode: false }, "allowed"],
		["losing a share silences the grant", { connection: "active", grant: "edit", column: "granter-lost-access", required: "read", readOnlyMode: false }, "not_found"],
		["trash hides the column", { connection: "active", grant: "edit", column: "trashed", required: "read", readOnlyMode: false }, "not_found"],
		["revocation beats every grant", { connection: "revoked", grant: "edit", column: "owned", required: "read", readOnlyMode: false }, "unauthorized"],
		["an expired grant is no grant", { connection: "active", grant: "expired-edit", column: "owned", required: "read", readOnlyMode: false }, "not_found"],
	])("%s", (_name, cell, outcome) => {
		expect(decide(cell)).toBe(outcome);
	});

	it("names the account, not the agent, as the membership being checked", () => {
		const decision = decideAgentColumnAccess({
			now: NOW,
			readOnlyMode: false,
			connection: { userId: OTHER, expiresAt: NOW + 1, revokedAt: null },
			grant: { level: "edit", expiresAt: null },
			column: COLUMNS.owned,
			required: "read",
		});
		expect(decision).toEqual({ allowed: false, code: "not_found", status: 404 });
	});
});
