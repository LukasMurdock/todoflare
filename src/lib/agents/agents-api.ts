import { z } from "zod";
import {
	agentResponseSchema,
	createAgentResponseSchema,
	grantableColumnsResponseSchema,
	listAgentChangesResponseSchema,
	listAgentsResponseSchema,
	undoAgentChangeResponseSchema,
	type AgentGrantLevel,
} from "../api/agent-contract";
import { API_ROUTES, routePath, type ApiRoute } from "../api/routes";
import { accountRequestHeaders } from "../account-request-headers";
import { isRecentAuthenticationRequired, RecentAuthenticationRequiredError } from "../auth-client";

/** The agent API is switched off on this deployment; agent UI hides itself. */
export class AgentAccessDisabledError extends Error {
	constructor() {
		super("Agent access is not available");
	}
}

export class AgentApiError extends Error {}

async function request<T extends z.ZodType>(
	accountId: string | null,
	route: ApiRoute,
	path: string,
	schema: T,
	body?: unknown,
): Promise<z.output<T>> {
	const response = await fetch(path, {
		method: route.method,
		credentials: "same-origin",
		headers: {
			...(accountId ? accountRequestHeaders(accountId) : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await response.json().catch(() => null)) as { error?: string; display?: string; message?: string; code?: string } | null;
	if (response.status === 404 && json?.code === "not_found" && route === API_ROUTES.listAgents) throw new AgentAccessDisabledError();
	if (!response.ok && isRecentAuthenticationRequired(json)) {
		throw new RecentAuthenticationRequiredError(agentErrorMessage(response.status, json));
	}
	if (!response.ok) throw new AgentApiError(agentErrorMessage(response.status, json));
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw new AgentApiError("Unexpected response from the server");
	return parsed.data;
}

/** What a person reads when a request fails: the server's sentence, never its error code. */
export function agentErrorMessage(status: number, body: { display?: string; message?: string } | null): string {
	return body?.display ?? body?.message ?? `Something went wrong (${status}). Please try again.`;
}

const revokedSchema = z.object({ success: z.literal(true) });
const decisionResponseSchema = z.object({ redirectTo: z.string() });

export const agentsApi = {
	list: (accountId: string) => request(accountId, API_ROUTES.listAgents, API_ROUTES.listAgents.path, listAgentsResponseSchema).then((r) => r.agents),
	create: (accountId: string, name: string, expiresInDays: number, grants: Array<{ columnId: string; level: AgentGrantLevel }> = []) =>
		request(accountId, API_ROUTES.createAgent, API_ROUTES.createAgent.path, createAgentResponseSchema, { name, expiresInDays, grants }),
	revoke: (accountId: string, agentId: string) =>
		request(accountId, API_ROUTES.revokeAgent, routePath(API_ROUTES.revokeAgent.path, { agentId }), revokedSchema),
	setGrant: (accountId: string, agentId: string, columnId: string, level: AgentGrantLevel) =>
		request(accountId, API_ROUTES.setAgentGrant, routePath(API_ROUTES.setAgentGrant.path, { agentId, id: columnId }), agentResponseSchema, { level }).then((r) => r.agent),
	removeGrant: (accountId: string, agentId: string, columnId: string) =>
		request(accountId, API_ROUTES.removeAgentGrant, routePath(API_ROUTES.removeAgentGrant.path, { agentId, id: columnId }), agentResponseSchema).then((r) => r.agent),
	grantableColumns: (accountId: string) =>
		request(accountId, API_ROUTES.grantableColumns, API_ROUTES.grantableColumns.path, grantableColumnsResponseSchema).then((r) => r.columns),
	changes: (accountId: string, columnId: string) =>
		request(accountId, API_ROUTES.listAgentChanges, routePath(API_ROUTES.listAgentChanges.path, { id: columnId }), listAgentChangesResponseSchema).then((r) => r.changes),
	/** The person's answer on the OAuth consent page; approving needs a recent sign-in. */
	decideAuthorization: (accountId: string, decision: Record<string, unknown>) =>
		request(accountId, API_ROUTES.decideAuthorization, API_ROUTES.decideAuthorization.path, decisionResponseSchema, decision).then((r) => r.redirectTo),
	undo: (accountId: string, columnId: string, changeId: string) =>
		request(accountId, API_ROUTES.undoAgentChange, routePath(API_ROUTES.undoAgentChange.path, { id: columnId, changeId }), undoAgentChangeResponseSchema),
};

/** What a person sees for each level, everywhere a level is chosen. */
export const AGENT_LEVEL_LABELS: Record<AgentGrantLevel, string> = {
	read: "Read",
	append: "Add items",
	edit: "Edit",
};

export const AGENT_LEVEL_DESCRIPTIONS: Record<AgentGrantLevel, string> = {
	read: "Can read the column",
	append: "Can read and add items, never change or remove them",
	edit: "Can read, add, change, check off and delete items",
};

export function mcpEndpointUrl(origin = window.location.origin): string {
	return `${origin}${API_ROUTES.mcp.path}`;
}
