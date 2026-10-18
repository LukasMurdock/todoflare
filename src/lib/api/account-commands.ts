import { z } from "zod";
import {
	accountIdContractSchema,
	columnIdContractSchema,
	createColumnResponseSchema,
	deleteColumnResponseSchema,
	disablePublicColumnResponseSchema,
	enablePublicColumnResponseSchema,
	restoreColumnResponseSchema,
	updateAccountColumnsResponseSchema,
	updateColumnSharingResponseSchema,
	updateHiddenColumnsResponseSchema,
} from "./account-contract";
import { routePath } from "./routes";

/**
 * The single declaration of every offline-capable account command.
 *
 * Each entry states the persisted payload, the HTTP route that applies it and
 * the wire contract on both sides. The command type list, payload types, the
 * persisted-outbox parser, the client executor's request plumbing and the
 * server route registration are all derived from this table.
 */

type CommandMethod = "POST" | "PUT" | "DELETE";

interface AccountCommandDefinition<
	TPayload extends z.ZodType,
	TBody extends z.ZodType | null,
	TResponse extends z.ZodType,
> {
	method: CommandMethod;
	/** Hono route pattern; `:id` is the only path parameter (a column ID). */
	path: string;
	/** Shape persisted in the mutation outbox, validated on every reload. */
	payload: TPayload;
	/** Request body the server validates, or null for bodiless requests. */
	body: TBody;
	/** The column a command acts on, used to discard it when access is lost. */
	affectedColumnId(payload: z.output<TPayload>): string | null;
	/** Maps a persisted payload onto the route's path parameter and body. */
	request(
		payload: z.output<TPayload>,
	): { id?: string } & (TBody extends z.ZodType ? { body: z.input<TBody> } : object);
	response: TResponse;
}

function defineCommand<
	TPayload extends z.ZodType,
	TBody extends z.ZodType | null,
	TResponse extends z.ZodType,
>(
	definition: AccountCommandDefinition<TPayload, TBody, TResponse>,
): AccountCommandDefinition<TPayload, TBody, TResponse> {
	return definition;
}

const columnIdList = z.array(columnIdContractSchema).max(100);
const columnPayload = z.object({ columnId: columnIdContractSchema });
const sharePayload = z.object({
	columnId: columnIdContractSchema,
	targetAccountId: accountIdContractSchema,
});
const shareBody = z.object({ targetAccountId: accountIdContractSchema }).strict();

export const ACCOUNT_COMMANDS = {
	"column.create": defineCommand({
		method: "POST",
		path: "/api/column",
		payload: columnPayload,
		// Scripts may omit columnId and let the server allocate one.
		affectedColumnId: ({ columnId }) => columnId,
		body: z.object({ columnId: columnIdContractSchema.optional() }).strict(),
		request: ({ columnId }) => ({ body: { columnId } }),
		response: createColumnResponseSchema,
	}),
	"column.delete": defineCommand({
		method: "DELETE",
		path: "/api/column/:id",
		payload: columnPayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: null,
		request: ({ columnId }) => ({ id: columnId }),
		response: deleteColumnResponseSchema,
	}),
	"column.restore": defineCommand({
		method: "POST",
		path: "/api/column/:id/restore",
		payload: columnPayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: null,
		request: ({ columnId }) => ({ id: columnId }),
		response: restoreColumnResponseSchema,
	}),
	"column.reorder": defineCommand({
		method: "PUT",
		path: "/api/account/columns",
		payload: z.object({ columnOrder: columnIdList }),
		affectedColumnId: () => null,
		body: z.object({ columnOrder: columnIdList }).strict(),
		request: ({ columnOrder }) => ({ body: { columnOrder } }),
		response: updateAccountColumnsResponseSchema,
	}),
	"column.share": defineCommand({
		method: "POST",
		path: "/api/column/:id/share",
		payload: sharePayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: shareBody,
		request: ({ columnId, targetAccountId }) => ({
			id: columnId,
			body: { targetAccountId },
		}),
		response: updateColumnSharingResponseSchema,
	}),
	"column.revoke": defineCommand({
		method: "DELETE",
		path: "/api/column/:id/share",
		payload: sharePayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: shareBody,
		request: ({ columnId, targetAccountId }) => ({
			id: columnId,
			body: { targetAccountId },
		}),
		response: updateColumnSharingResponseSchema,
	}),
	"column.public.enable": defineCommand({
		method: "POST",
		path: "/api/column/:id/public",
		payload: columnPayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: null,
		request: ({ columnId }) => ({ id: columnId }),
		response: enablePublicColumnResponseSchema,
	}),
	"column.public.disable": defineCommand({
		method: "DELETE",
		path: "/api/column/:id/public",
		payload: columnPayload,
		affectedColumnId: ({ columnId }) => columnId,
		body: null,
		request: ({ columnId }) => ({ id: columnId }),
		response: disablePublicColumnResponseSchema,
	}),
	"column.hide_shared": defineCommand({
		method: "PUT",
		path: "/api/account/hidden",
		payload: z.object({ hiddenSharedColumns: columnIdList }),
		affectedColumnId: () => null,
		body: z.object({ hiddenSharedColumns: columnIdList }).strict(),
		request: ({ hiddenSharedColumns }) => ({ body: { hiddenSharedColumns } }),
		response: updateHiddenColumnsResponseSchema,
	}),
};

export type AccountCommands = typeof ACCOUNT_COMMANDS;
export type AccountCommandType = keyof AccountCommands;

export const ACCOUNT_COMMAND_TYPES = Object.keys(
	ACCOUNT_COMMANDS,
) as AccountCommandType[];

export type AccountCommandPayloadMap = {
	[T in AccountCommandType]: z.output<AccountCommands[T]["payload"]>;
};

export type AccountCommandResponse<T extends AccountCommandType> = z.output<
	AccountCommands[T]["response"]
>;

export function isAccountCommandType(value: unknown): value is AccountCommandType {
	return typeof value === "string" && Object.hasOwn(ACCOUNT_COMMANDS, value);
}

/** Fills a command route's `:id` parameter. */
export function accountCommandUrl(path: string, id: string | undefined): string {
	return routePath(path, (id === undefined ? {} : { id }) as never);
}
