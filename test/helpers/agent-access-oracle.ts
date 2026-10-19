// The agent permission rules, stated independently of the implementation.
// Both the pure decision table and the end-to-end MCP table check against it.
import type { AgentGrantLevel } from "../../src/lib/api/agent-contract";

export const CONNECTION_STATES = ["none", "active", "revoked", "expired"] as const;
export const GRANT_STATES = ["none", "read", "append", "edit", "expired-edit"] as const;
export const COLUMN_STATES = ["missing", "owned", "shared-with-granter", "granter-lost-access", "trashed"] as const;

export type OracleCell = {
	connection: (typeof CONNECTION_STATES)[number];
	grant: (typeof GRANT_STATES)[number];
	column: (typeof COLUMN_STATES)[number];
	required: AgentGrantLevel;
	readOnlyMode: boolean;
};
export type OracleOutcome = "allowed" | "unauthorized" | "not_found" | "insufficient_grant" | "read_only_mode";

const RANK: Record<string, number> = { read: 1, append: 2, edit: 3 };

/** First matching rule wins. Each rule must decide at least one cell. */
export const ORACLE_RULES: Array<[rule: string, matches: (cell: OracleCell) => boolean, outcome: OracleOutcome]> = [
	["a missing, revoked or expired credential is unauthenticated", (c) => c.connection !== "active", "unauthorized"],
	["an ungranted column is invisible", (c) => c.grant === "none" || c.grant === "expired-edit", "not_found"],
	[
		"a column the granter cannot reach is invisible",
		(c) => c.column !== "owned" && c.column !== "shared-with-granter",
		"not_found",
	],
	["a grant below the need is refused", (c) => RANK[c.grant] < RANK[c.required], "insufficient_grant"],
	["writes stop in read-only mode", (c) => c.required !== "read" && c.readOnlyMode, "read_only_mode"],
	["everything else is allowed", () => true, "allowed"],
];

export function expectedOutcome(cell: OracleCell): { rule: string; outcome: OracleOutcome } {
	const [rule, , outcome] = ORACLE_RULES.find(([, matches]) => matches(cell))!;
	return { rule, outcome };
}
