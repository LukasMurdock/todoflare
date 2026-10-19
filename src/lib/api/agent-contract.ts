import { z } from "zod";
import { columnIdContractSchema, timestampContractSchema } from "./account-contract";

/**
 * What an agent may do with one column. Each level includes the ones before it:
 * - read: see the column's content
 * - append: add new items; never changes or removes anything already there
 * - edit: change, check off, reorder and delete existing items
 */
export const AGENT_GRANT_LEVELS = ["read", "append", "edit"] as const;
export type AgentGrantLevel = (typeof AGENT_GRANT_LEVELS)[number];

export function agentLevelIncludes(granted: AgentGrantLevel, required: AgentGrantLevel): boolean {
	return AGENT_GRANT_LEVELS.indexOf(granted) >= AGENT_GRANT_LEVELS.indexOf(required);
}

export const AGENT_CONNECTION_DEFAULT_DAYS = 30;
export const AGENT_CONNECTION_MAX_DAYS = 365;
export const AGENT_CONNECTIONS_PER_ACCOUNT = 20;
export const AGENT_GRANTS_PER_CONNECTION = 200;

export const agentIdContractSchema = z.string().regex(/^agt_[A-Za-z0-9_-]{22}$/, "Invalid agent ID");
export const agentGrantLevelSchema = z.enum(AGENT_GRANT_LEVELS);

export const agentGrantContractSchema = z
	.object({
		columnId: columnIdContractSchema,
		level: agentGrantLevelSchema,
		createdAt: timestampContractSchema,
		updatedAt: timestampContractSchema,
		expiresAt: timestampContractSchema.nullable(),
	})
	.strict();
export type AgentGrant = z.output<typeof agentGrantContractSchema>;

export const agentConnectionContractSchema = z
	.object({
		id: agentIdContractSchema,
		name: z.string(),
		createdAt: timestampContractSchema,
		expiresAt: timestampContractSchema,
		revokedAt: timestampContractSchema.nullable(),
		lastUsedAt: timestampContractSchema.nullable(),
		grants: z.array(agentGrantContractSchema),
	})
	.strict();
export type AgentConnection = z.output<typeof agentConnectionContractSchema>;

export const createAgentBodySchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		expiresInDays: z.number().int().min(1).max(AGENT_CONNECTION_MAX_DAYS).optional(),
	})
	.strict();

export const setAgentGrantBodySchema = z
	.object({
		level: agentGrantLevelSchema,
		/** Absolute expiry; omitted or null lasts as long as the connection. */
		expiresAt: timestampContractSchema.nullable().optional(),
	})
	.strict();

export const listAgentsResponseSchema = z.object({ agents: z.array(agentConnectionContractSchema) });
/** The token is returned exactly once, at creation; only its hash is stored. */
export const createAgentResponseSchema = z.object({ agent: agentConnectionContractSchema, token: z.string() });
export const agentResponseSchema = z.object({ agent: agentConnectionContractSchema });
