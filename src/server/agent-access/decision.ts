import { agentLevelIncludes, type AgentGrantLevel } from "../../lib/api/agent-contract";
import { hasColumnAccess, type ColumnAccessMetadata } from "../../lib/column-access";

/**
 * Everything that decides whether an agent may act on one column, gathered
 * before deciding so the decision itself is pure and exhaustively testable.
 */
export interface AgentAccessFacts {
	now: number;
	readOnlyMode: boolean;
	/** The connection the bearer token resolved to, or null if it resolved to none. */
	connection: { userId: string; expiresAt: number; revokedAt: number | null } | null;
	grant: { level: AgentGrantLevel; expiresAt: number | null } | null;
	/** Authoritative column state from its Durable Object; null when it does not exist. */
	column: { meta: ColumnAccessMetadata; trashed: boolean } | null;
	/** What the requested operation needs. */
	required: AgentGrantLevel;
}

export type AgentAccessDenial =
	/** No usable credential: missing, unknown, revoked or expired. */
	| { allowed: false; code: "unauthorized"; status: 401 }
	/**
	 * The agent cannot see this column. Deliberately identical whether the
	 * column is missing, ungranted, trashed or no longer reachable by the
	 * granting account, so an agent cannot probe for columns.
	 */
	| { allowed: false; code: "not_found"; status: 404 }
	/** The agent can see the column but its grant is below what this needs. */
	| { allowed: false; code: "insufficient_grant"; status: 403 }
	| { allowed: false; code: "read_only_mode"; status: 503 };

export type AgentAccessDecision = { allowed: true; level: AgentGrantLevel } | AgentAccessDenial;

const UNAUTHORIZED: AgentAccessDenial = { allowed: false, code: "unauthorized", status: 401 };
const NOT_FOUND: AgentAccessDenial = { allowed: false, code: "not_found", status: 404 };

/**
 * An agent's access is the intersection of its grant and its account's current
 * access: losing a share, or the column moving to trash, silences every grant
 * on it without touching the grants themselves.
 */
export function decideAgentColumnAccess(facts: AgentAccessFacts): AgentAccessDecision {
	const { connection, grant, column, now } = facts;
	if (!connection || connection.revokedAt !== null || connection.expiresAt <= now) return UNAUTHORIZED;
	if (!grant || (grant.expiresAt !== null && grant.expiresAt <= now)) return NOT_FOUND;
	if (!column || column.trashed || !hasColumnAccess(column.meta, connection.userId)) return NOT_FOUND;
	if (!agentLevelIncludes(grant.level, facts.required)) {
		return { allowed: false, code: "insufficient_grant", status: 403 };
	}
	if (facts.required !== "read" && facts.readOnlyMode) {
		return { allowed: false, code: "read_only_mode", status: 503 };
	}
	return { allowed: true, level: grant.level };
}
