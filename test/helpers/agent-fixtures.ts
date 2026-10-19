// Accounts, agent connections and grants created through the Worker, for the
// agent management and MCP tests.
import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import worker, { type Bindings } from "../../src/index";
import {
	type AgentConnection,
	createAgentResponseSchema,
	listAgentsResponseSchema,
} from "../../src/lib/api/agent-contract";
import { ACCOUNT_COMMANDS } from "../../src/lib/api/account-commands";
import { API_ROUTES, routePath } from "../../src/lib/api/routes";
import { headers } from "./metadata-fixtures";
import * as Y from "yjs";
import { docFromPlate } from "./plate-doc";

export const BASE = "http://example.com";

export async function call(accountId: string | null, route: { method: string; path: string }, body?: unknown, extra: Record<string, string> = {}) {
	return SELF.fetch(`${BASE}${route.path}`, {
		method: route.method,
		headers: { ...(accountId ? headers(accountId) : { "Content-Type": "application/json" }), ...extra },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function createAgent(accountId: string, name = "Claude Code") {
	const response = await call(accountId, API_ROUTES.createAgent, { name });
	expect(response.status).toBe(201);
	return createAgentResponseSchema.parse(await response.json());
}

export function commandRoute(name: "column.share" | "column.revoke" | "column.delete", columnId: string) {
	const { method, path } = ACCOUNT_COMMANDS[name];
	return { method, path: routePath(path, { id: columnId }) };
}

export function grantRoute(method: "PUT" | "DELETE", agentId: string, columnId: string) {
	return { method, path: routePath(API_ROUTES.setAgentGrant.path, { agentId, id: columnId }) };
}

export async function setGrant(accountId: string, agentId: string, columnId: string, body: unknown = { level: "read" }) {
	return call(accountId, grantRoute("PUT", agentId, columnId), body);
}

export async function listAgents(accountId: string): Promise<AgentConnection[]> {
	const response = await call(accountId, API_ROUTES.listAgents);
	expect(response.status).toBe(200);
	return listAgentsResponseSchema.parse(await response.json()).agents;
}

export async function fetchWithEnv(request: Request, overrides: Partial<Bindings>) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...overrides } as Bindings, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}


/** Replaces a column's content, keeping its metadata. */
export async function seedColumn(columnId: string, value: Array<Record<string, unknown>>) {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const exported = (await (await stub.fetch("http://do/export")).json()) as { meta: unknown };
	const yjs = Array.from(Y.encodeStateAsUpdate(docFromPlate(value)));
	const response = await stub.fetch("http://do/import", {
		method: "POST",
		body: JSON.stringify({ meta: exported.meta, yjs, trashedAt: null }),
	});
	expect(response.ok).toBe(true);
}

export interface McpResponse {
	status: number;
	body: { result?: Record<string, unknown> & ToolCallResult; error?: { code: number; message: string } } | null;
	headers: Headers;
}

export interface ToolCallResult {
	content?: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

let rpcId = 0;

/** One JSON-RPC request to the MCP endpoint, as an agent would send it. */
export async function mcp(
	token: string | null,
	method: string,
	params?: Record<string, unknown>,
	options: { env?: Partial<Bindings>; headers?: Record<string, string> } = {},
): Promise<McpResponse> {
	const request = new Request(`${BASE}${API_ROUTES.mcp.path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...options.headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	const response = options.env ? await fetchWithEnv(request, options.env) : await SELF.fetch(request);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

export async function callTool(token: string | null, name: string, args: Record<string, unknown> = {}, options?: Parameters<typeof mcp>[3]) {
	return mcp(token, "tools/call", { name, arguments: args }, options);
}

export function routeForRevoke(agentId: string) {
	return { method: API_ROUTES.revokeAgent.method, path: routePath(API_ROUTES.revokeAgent.path, { agentId }) };
}
