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
		/** The OAuth client it was authorized for, or null for a personal token. */
		clientId: z.string().nullable(),
		grants: z.array(agentGrantContractSchema),
	})
	.strict();
export type AgentConnection = z.output<typeof agentConnectionContractSchema>;

export const createAgentBodySchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		expiresInDays: z.number().int().min(1).max(AGENT_CONNECTION_MAX_DAYS).optional(),
		/** Columns the new connection gets, granted before its token is returned. */
		grants: z
			.array(z.object({ columnId: columnIdContractSchema, level: agentGrantLevelSchema }).strict())
			.max(AGENT_GRANTS_PER_CONNECTION)
			.refine((grants) => new Set(grants.map((grant) => grant.columnId)).size === grants.length, "Each column may appear once")
			.optional(),
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

export const agentChangeIdContractSchema = z.string().regex(/^chg_[A-Za-z0-9_-]{22}$/, "Invalid change ID");

export const AGENT_ITEM_STYLES = ["paragraph", "todo", "bullet", "numbered", "heading1", "heading2", "heading3"] as const;
export const agentDiffItemSchema = z
	.object({ text: z.string(), style: z.enum(AGENT_ITEM_STYLES), checked: z.boolean(), depth: z.number().int().min(0) })
	.strict();
export type AgentDiffItem = z.output<typeof agentDiffItemSchema>;
/** What an agent change did to the column's items, for people to read. */
export const agentChangeDiffSchema = z
	.object({
		entries: z.array(
			z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("added"), item: agentDiffItemSchema }).strict(),
				z.object({ kind: z.literal("removed"), item: agentDiffItemSchema }).strict(),
				z.object({ kind: z.literal("changed"), before: agentDiffItemSchema, after: agentDiffItemSchema }).strict(),
			]),
		),
		/** Entries left out to keep the list short. */
		omitted: z.number().int().min(0),
	})
	.strict();
export type AgentChangeDiff = z.output<typeof agentChangeDiffSchema>;

/** One edit an agent made to a column, as recorded by the column. */
export const agentChangeContractSchema = z
	.object({
		id: agentChangeIdContractSchema,
		agentId: agentIdContractSchema,
		agentName: z.string(),
		/** The account the agent acted for. */
		accountId: z.string(),
		tool: z.string(),
		summary: z.string(),
		itemIds: z.array(z.string()),
		createdAt: timestampContractSchema,
		undoneAt: timestampContractSchema.nullable(),
		/** An account ID, or `agent:<agentId>` when the agent undid it itself. */
		undoneBy: z.string().nullable(),
		undoResult: z.object({ restored: z.number(), kept: z.number(), version: z.string() }).nullable(),
		diff: agentChangeDiffSchema,
	})
	.strict();
export type AgentChange = z.output<typeof agentChangeContractSchema>;

export const listAgentChangesResponseSchema = z.object({ changes: z.array(agentChangeContractSchema) });
export const undoAgentChangeResponseSchema = z.object({
	ok: z.literal(true),
	restored: z.number(),
	kept: z.number(),
	version: z.string(),
});

export const grantableColumnsResponseSchema = z.object({
	columns: z.array(z.object({ columnId: columnIdContractSchema, title: z.string(), owned: z.boolean() }).strict()),
});
export type GrantableColumn = z.output<typeof grantableColumnsResponseSchema>["columns"][number];
