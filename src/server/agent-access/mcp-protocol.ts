import { z } from "zod";

/**
 * The slice of the Model Context Protocol this server speaks, over Streamable
 * HTTP with JSON responses only. It is dual-era:
 *
 * - **Modern** (2026-07-28): stateless. Every request carries its protocol
 *   version and client capabilities in `_meta`, mirrored into headers.
 * - **Legacy** (2025-03-26 to 2025-11-25): an `initialize` handshake, then
 *   requests without per-request metadata. This server keeps no session, so
 *   legacy requests are served statelessly too.
 *
 * A request selects its era: `initialize` is legacy; any request carrying
 * `_meta["io.modelcontextprotocol/protocolVersion"]` is modern.
 */
export const MCP_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const MCP_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_PROTOCOL_VERSIONS = [...MCP_MODERN_PROTOCOL_VERSIONS, ...MCP_LEGACY_PROTOCOL_VERSIONS] as const;
export const MCP_LATEST_LEGACY_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSIONS[0];

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Picks the legacy version an `initialize` request will get. */
export function negotiateLegacyProtocolVersion(requested: unknown): string {
	return MCP_LEGACY_PROTOCOL_VERSIONS.includes(requested as never) ? (requested as string) : MCP_LATEST_LEGACY_PROTOCOL_VERSION;
}

export const JSON_RPC_ERRORS = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	/** Modern: headers missing, malformed, or disagreeing with the body. */
	headerMismatch: -32020,
	/** Modern: the requested protocol version is not served here. */
	unsupportedProtocolVersion: -32022,
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

/** True when the message is framed for the modern, per-request-metadata era. */
export function isModernMessage(message: JsonRpcMessage): boolean {
	if (message.method === "initialize") return false;
	const meta = message.params?._meta;
	return !!meta && typeof meta === "object" && META_PROTOCOL_VERSION in meta;
}

/** Undoes the `=?base64?…?=` sentinel clients use for header-unsafe values. */
export function decodeHeaderValue(value: string): string | null {
	const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
	if (!match) return value;
	try {
		const bytes = Uint8Array.from(atob(match[1]!), (char) => char.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export type ModernValidation =
	| { ok: true; protocolVersion: string }
	| { ok: false; status: 400; code: number; message: string; data?: unknown };

/**
 * Checks a modern request's per-request metadata and its mirrored headers.
 * The version is settled first, so a client on any newer revision can always
 * learn which versions to retry with, whatever else that revision changed.
 */
export function validateModernRequest(
	message: JsonRpcMessage & { id: JsonRpcId; method: string },
	headers: { get(name: string): string | null },
): ModernValidation {
	const meta = message.params?._meta as Record<string, unknown>;
	const protocolVersion = meta[META_PROTOCOL_VERSION];
	const invalidParams = (detail: string): ModernValidation => ({ ok: false, status: 400, code: JSON_RPC_ERRORS.invalidParams, message: detail });
	const mismatch = (detail: string): ModernValidation => ({ ok: false, status: 400, code: JSON_RPC_ERRORS.headerMismatch, message: `Header mismatch: ${detail}` });
	if (typeof protocolVersion !== "string") return invalidParams(`${META_PROTOCOL_VERSION} must be a string`);

	const versionHeader = headers.get("MCP-Protocol-Version");
	if (versionHeader === null) return mismatch("MCP-Protocol-Version header is required");
	if (versionHeader !== protocolVersion) return mismatch(`MCP-Protocol-Version header '${versionHeader}' does not match body value '${protocolVersion}'`);
	if (!MCP_PROTOCOL_VERSIONS.includes(protocolVersion as never)) {
		return {
			ok: false,
			status: 400,
			code: JSON_RPC_ERRORS.unsupportedProtocolVersion,
			message: "Unsupported protocol version",
			data: { supported: [...MCP_PROTOCOL_VERSIONS], requested: protocolVersion },
		};
	}

	const capabilities = meta[META_CLIENT_CAPABILITIES];
	if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
		return invalidParams(`Requests must carry ${META_CLIENT_CAPABILITIES} in _meta`);
	}

	const methodHeader = headers.get("Mcp-Method");
	if (methodHeader === null) return mismatch("Mcp-Method header is required");
	if (methodHeader !== message.method) return mismatch(`Mcp-Method header '${methodHeader}' does not match body value '${message.method}'`);
	if (message.method === "tools/call") {
		const rawName = headers.get("Mcp-Name");
		if (rawName === null) return mismatch("Mcp-Name header is required for tools/call");
		const name = decodeHeaderValue(rawName);
		if (name === null) return mismatch("Mcp-Name header is not valid base64 UTF-8");
		if (name !== message.params?.name) return mismatch(`Mcp-Name header '${name}' does not match body value '${String(message.params?.name)}'`);
	}
	return { ok: true, protocolVersion };
}
