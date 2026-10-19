import { z } from "zod";
import {
	AGENT_CONNECTION_DEFAULT_DAYS,
	agentChangeIdContractSchema,
	agentIdContractSchema,
	createAgentBodySchema,
	setAgentGrantBodySchema,
} from "../../lib/api/agent-contract";
import { columnIdContractSchema } from "../../lib/api/account-contract";
import { API_ROUTES } from "../../lib/api/routes";
import { hasColumnAccess } from "../../lib/column-access";
import { requireAccountCredential } from "../../lib/http-account-auth";
import { agentStore, type AgentStoreFailure } from "../agent-access/store";
import { loadColumnAccessState } from "../agent-access/column-state";
import { apiErrorResponse, durableObjectUnavailableResponse } from "../http/responses";
import { blockWritesIfReadOnly } from "../http/guards";
import { validateJsonBody, validateRequestInput } from "../http/request-validation";
import type { App, AppContext, Bindings } from "../bindings";

declare const __TODOFLARE_E2E__: boolean;

/** On when configured, and always in E2E builds, which exercise every feature. */
export function isAgentAccessEnabled(env: Pick<Bindings, "AGENT_ACCESS_ENABLED">): boolean {
	const compiledE2E = typeof __TODOFLARE_E2E__ !== "undefined" && __TODOFLARE_E2E__;
	return env.AGENT_ACCESS_ENABLED === "true" || compiledE2E;
}

const agentPathSchema = z.object({ agentId: agentIdContractSchema }).strict();
const grantPathSchema = z.object({ agentId: agentIdContractSchema, id: columnIdContractSchema }).strict();
const changePathSchema = z.object({ id: columnIdContractSchema, changeId: agentChangeIdContractSchema }).strict();
const columnPathSchema = z.object({ id: columnIdContractSchema }).strict();

const NO_STORE = { "Cache-Control": "private, no-store" };

function disabledResponse(): Response {
	return apiErrorResponse("not_found", "Not found", 404);
}

function storeFailureResponse(reason: AgentStoreFailure): Response {
	return reason === "limit_reached"
		? apiErrorResponse("invalid_request", "Agent limit reached", 409)
		: apiErrorResponse("not_found", "Agent not found", 404);
}

/**
 * Agents are managed only through a passkey session. Bearer tokens never
 * authenticate here, so an agent cannot widen or extend its own access.
 */
async function requireManager(c: AppContext) {
	if (!isAgentAccessEnabled(c.env)) return { ok: false as const, response: disabledResponse() };
	return requireAccountCredential(c.req.raw, c.env);
}

export function registerAgentRoutes(app: App) {
	app.on(API_ROUTES.listAgents.method, API_ROUTES.listAgents.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const agents = await agentStore(c.env.AUTH_DB).list(auth.accountId, Date.now());
		return c.json({ agents }, 200, NO_STORE);
	});

	app.on(API_ROUTES.createAgent.method, API_ROUTES.createAgent.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const readOnly = blockWritesIfReadOnly(c);
		if (readOnly) return readOnly;
		const body = await validateJsonBody(c, createAgentBodySchema);
		if (!body.ok) return body.response;
		const created = await agentStore(c.env.AUTH_DB).create({
			userId: auth.accountId,
			name: body.data.name,
			expiresInDays: body.data.expiresInDays ?? AGENT_CONNECTION_DEFAULT_DAYS,
			now: Date.now(),
		});
		if (!created.ok) return storeFailureResponse(created.reason);
		return c.json(created.value, 201, NO_STORE);
	});

	// Revocation stays available in read-only mode: cutting off access is never
	// the write an incident needs to prevent.
	app.on(API_ROUTES.revokeAgent.method, API_ROUTES.revokeAgent.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const path = validateRequestInput(c, agentPathSchema, { agentId: c.req.param("agentId") });
		if (!path.ok) return path.response;
		const revoked = await agentStore(c.env.AUTH_DB).revoke(auth.accountId, path.data.agentId, Date.now());
		if (!revoked.ok) return storeFailureResponse(revoked.reason);
		return c.json({ success: true }, 200, NO_STORE);
	});

	app.on(API_ROUTES.setAgentGrant.method, API_ROUTES.setAgentGrant.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const readOnly = blockWritesIfReadOnly(c);
		if (readOnly) return readOnly;
		const path = validateRequestInput(c, grantPathSchema, {
			agentId: c.req.param("agentId"),
			id: c.req.param("id"),
		});
		if (!path.ok) return path.response;
		const body = await validateJsonBody(c, setAgentGrantBodySchema);
		if (!body.ok) return body.response;
		const now = Date.now();
		if (body.data.expiresAt != null && body.data.expiresAt <= now) {
			return apiErrorResponse("invalid_request", "Grant expiry must be in the future", 400);
		}

		// An account can delegate only what it can reach itself, right now.
		const column = await loadColumnAccessState(c.env.COLUMN_ROOM, path.data.id);
		if (!column.ok) return durableObjectUnavailableResponse();
		if (!column.state || column.state.trashed || !hasColumnAccess(column.state.meta, auth.accountId)) {
			return apiErrorResponse("not_found", "Column not found", 404);
		}

		const updated = await agentStore(c.env.AUTH_DB).setGrant({
			userId: auth.accountId,
			connectionId: path.data.agentId,
			columnId: path.data.id,
			level: body.data.level,
			expiresAt: body.data.expiresAt ?? null,
			now,
		});
		if (!updated.ok) return storeFailureResponse(updated.reason);
		return c.json({ agent: updated.value }, 200, NO_STORE);
	});

	// Removing a grant only narrows access, so it needs no column check and
	// stays available in read-only mode.
	app.on(API_ROUTES.removeAgentGrant.method, API_ROUTES.removeAgentGrant.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const path = validateRequestInput(c, grantPathSchema, {
			agentId: c.req.param("agentId"),
			id: c.req.param("id"),
		});
		if (!path.ok) return path.response;
		const updated = await agentStore(c.env.AUTH_DB).removeGrant({
			userId: auth.accountId,
			connectionId: path.data.agentId,
			columnId: path.data.id,
			now: Date.now(),
		});
		if (!updated.ok) return storeFailureResponse(updated.reason);
		return c.json({ agent: updated.value }, 200, NO_STORE);
	});

	// Any member of a column can see, and undo, what agents did to it: they can
	// already edit everything the agent touched.
	app.on(API_ROUTES.listAgentChanges.method, API_ROUTES.listAgentChanges.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const column = await loadColumnAccessState(c.env.COLUMN_ROOM, path.data.id);
		if (!column.ok) return durableObjectUnavailableResponse();
		if (!column.state || !hasColumnAccess(column.state.meta, auth.accountId)) {
			return apiErrorResponse("not_found", "Column not found", 404);
		}
		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(path.data.id));
		const response = await stub.fetch(new Request("http://do/agent-changes"));
		if (!response.ok) return durableObjectUnavailableResponse();
		return c.json(await response.json(), 200, NO_STORE);
	});

	app.on(API_ROUTES.undoAgentChange.method, API_ROUTES.undoAgentChange.path, async (c) => {
		const auth = await requireManager(c);
		if (!auth.ok) return auth.response;
		const readOnly = blockWritesIfReadOnly(c);
		if (readOnly) return readOnly;
		const path = validateRequestInput(c, changePathSchema, { id: c.req.param("id"), changeId: c.req.param("changeId") });
		if (!path.ok) return path.response;
		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(path.data.id));
		// The Durable Object checks membership and trash atomically with the undo.
		const response = await stub.fetch(
			new Request("http://do/agent-undo", {
				method: "POST",
				body: JSON.stringify({ accountId: auth.accountId, changeId: path.data.changeId }),
			}),
		);
		if (response.status === 503) return response;
		const body = (await response.json()) as { ok: boolean; code?: string };
		if (response.status === 404) return apiErrorResponse("not_found", "Change not found", 404);
		if (body.code === "already_undone") return apiErrorResponse("invalid_request", "Change already undone", 409);
		return c.json(body, 200, NO_STORE);
	});
}
