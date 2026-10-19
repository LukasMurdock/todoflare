import { z } from "zod";

/**
 * The slice of the Model Context Protocol this server speaks: stateless
 * Streamable HTTP, one JSON-RPC message per POST, JSON responses only (no SSE
 * streams, no sessions, no server-initiated requests). Clients must accept
 * this per the transport specification.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested: unknown): string {
	return MCP_PROTOCOL_VERSIONS.includes(requested as never) ? (requested as string) : MCP_LATEST_PROTOCOL_VERSION;
}

export const JSON_RPC_ERRORS = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;

const requestIdSchema = z.union([z.string(), z.number().int()]);

export const jsonRpcMessageSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: requestIdSchema.optional(),
	method: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	result: z.unknown().optional(),
	error: z.unknown().optional(),
});
export type JsonRpcMessage = z.output<typeof jsonRpcMessageSchema>;
export type JsonRpcId = z.output<typeof requestIdSchema>;

export function jsonRpcResult(id: JsonRpcId, result: unknown) {
	return { jsonrpc: "2.0" as const, id, result };
}

export function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown) {
	return { jsonrpc: "2.0" as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export function toolText(text: string, structuredContent?: Record<string, unknown>): ToolResult {
	return structuredContent ? { content: [{ type: "text", text }], structuredContent } : { content: [{ type: "text", text }] };
}

export function toolError(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
