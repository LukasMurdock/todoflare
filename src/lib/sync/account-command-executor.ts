import { normalizeAccountId, validateAccountId } from "../account";
import type { ZodType } from "zod";
import {
	createColumnResponseSchema,
	deleteColumnResponseSchema,
	disablePublicColumnResponseSchema,
	enablePublicColumnResponseSchema,
	restoreColumnResponseSchema,
	updateAccountColumnsResponseSchema,
	updateColumnSharingResponseSchema,
	updateHiddenColumnsResponseSchema,
} from "../api/account-contract";
import type {
	AccountCommandEffect,
	QueuedMutation,
} from "./contracts";
import type { MutationReplayResult } from "./mutation-queue-service";
import { mutationResultFromResponse } from "./replay-response";
import { e2eAccountHeaders } from "../e2e-auth";

export type AccountCommandExecutionResult = MutationReplayResult & {
	effects?: AccountCommandEffect[];
};

export interface AccountCommandExecutor {
	execute(
		mutation: QueuedMutation,
		options?: { signal?: AbortSignal },
	): Promise<AccountCommandExecutionResult>;
}

interface AccountCommandExecutorOptions {
	fetch?: typeof globalThis.fetch;
}

function invalidPayload(error: string): AccountCommandExecutionResult {
	return { kind: "drop", reason: "validation_failed", error };
}

function invalidSuccessfulResponse(
	operation: QueuedMutation["opType"],
): AccountCommandExecutionResult {
	return {
		kind: "retry",
		error: `Invalid successful response for ${operation}`,
	};
}

async function parseSuccessfulResponse<T>(
	response: Response,
	schema: ZodType<T>,
	operation: QueuedMutation["opType"],
): Promise<
	| { ok: true; data: T }
	| { ok: false; result: AccountCommandExecutionResult }
> {
	const body = await response
		.clone()
		.json()
		.catch(() => null);
	const parsed = schema.safeParse(body);
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, result: invalidSuccessfulResponse(operation) };
}

function isExpectedColumn(
	column: { id: string; ownerId: string },
	columnId: string,
	accountId: string,
): boolean {
	return (
		column.id === columnId &&
		normalizeAccountId(column.ownerId) === normalizeAccountId(accountId)
	);
}

async function classifyResponse(
	response: Response,
): Promise<AccountCommandExecutionResult> {
	return mutationResultFromResponse(response);
}

export function createAccountCommandExecutor(
	options: AccountCommandExecutorOptions,
): AccountCommandExecutor {
	const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);

	return {
		async execute(mutation, executionOptions) {
			const activeAccountId = mutation.entityId;
			const testHeaders = e2eAccountHeaders(activeAccountId);
			const signal = executionOptions?.signal;

			switch (mutation.opType) {
				case "column.create": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");

					const response = await fetchRequest("/api/column", {
						method: "POST",
						signal,
						headers: {
							...testHeaders,
							"Content-Type": "application/json",
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
						body: JSON.stringify({ columnId }),
					});
					if (!response.ok) return classifyResponse(response);

					const parsed = await parseSuccessfulResponse(
						response,
						createColumnResponseSchema,
						mutation.opType,
					);
					if (!parsed.ok) return parsed.result;
					if (!isExpectedColumn(parsed.data.column, columnId, activeAccountId)) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [
							{
								type: "column.created",
								queueId: mutation.queueId,
								column: parsed.data.column,
							},
						],
					};
				}

				case "column.reorder": {
					const { columnOrder } = mutation.payload;
					const response = await fetchRequest(
						"/api/account/columns",
						{
							method: "PUT",
							signal,
							headers: {
								...testHeaders,
								"Content-Type": "application/json",
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
							body: JSON.stringify({ columnOrder }),
						},
					);
					if (!response.ok) return classifyResponse(response);
					const parsed = await parseSuccessfulResponse(
						response,
						updateAccountColumnsResponseSchema,
						mutation.opType,
					);
					return parsed.ok ? { kind: "ack" } : parsed.result;
				}

				case "column.hide_shared": {
					const { hiddenSharedColumns } = mutation.payload;
					const response = await fetchRequest(
						"/api/account/hidden",
						{
							method: "PUT",
							signal,
							headers: {
								...testHeaders,
								"Content-Type": "application/json",
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
							body: JSON.stringify({ hiddenSharedColumns }),
						},
					);
					if (!response.ok) return classifyResponse(response);
					const parsed = await parseSuccessfulResponse(
						response,
						updateHiddenColumnsResponseSchema,
						mutation.opType,
					);
					return parsed.ok ? { kind: "ack" } : parsed.result;
				}

				case "column.delete": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const response = await fetchRequest(`/api/column/${columnId}`, {
						method: "DELETE",
						signal,
						headers: {
							...testHeaders,
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
					});
					if (!response.ok) return classifyResponse(response);
					const parsed = await parseSuccessfulResponse(
						response,
						deleteColumnResponseSchema,
						mutation.opType,
					);
					return parsed.ok
						? { kind: "ack", effects: [{ type: "column.deleted", columnId }] }
						: parsed.result;
				}

				case "column.restore": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const response = await fetchRequest(`/api/column/${columnId}/restore`, {
						method: "POST",
						signal,
						headers: {
							...testHeaders,
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
					});
					if (!response.ok) return classifyResponse(response);
					const parsed = await parseSuccessfulResponse(
						response,
						restoreColumnResponseSchema,
						mutation.opType,
					);
					if (!parsed.ok) return parsed.result;
					return isExpectedColumn(
						parsed.data.column,
						columnId,
						activeAccountId,
					)
						? { kind: "ack" }
						: invalidSuccessfulResponse(mutation.opType);
				}

				case "column.share":
				case "column.revoke": {
					const { columnId, targetAccountId } = mutation.payload;
					if (
						!columnId ||
						!targetAccountId ||
						!validateAccountId(targetAccountId)
					) {
						return invalidPayload(
							mutation.opType === "column.share"
								? "Invalid share payload"
								: "Invalid revoke payload",
						);
					}

					const isShare = mutation.opType === "column.share";
					const response = await fetchRequest(
						`/api/column/${columnId}/share`,
						{
							method: isShare ? "POST" : "DELETE",
							signal,
							headers: {
								...testHeaders,
								"Content-Type": "application/json",
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
							body: JSON.stringify({ targetAccountId }),
						},
					);
					if (!response.ok) return classifyResponse(response);

					const parsed = await parseSuccessfulResponse(
						response,
						updateColumnSharingResponseSchema,
						mutation.opType,
					);
					if (!parsed.ok) return parsed.result;
					const normalizedTarget = normalizeAccountId(targetAccountId);
					const containsTarget = parsed.data.sharedWith.some(
						(accountId) => normalizeAccountId(accountId) === normalizedTarget,
					);
					if (containsTarget !== isShare) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [
							{
								type: "column.sharing.updated",
								columnId,
								sharedWith: parsed.data.sharedWith,
							},
						],
					};
				}

				case "column.public.enable": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const response = await fetchRequest(`/api/column/${columnId}/public`, {
						method: "POST",
						signal,
						headers: {
							...testHeaders,
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
					});
					if (!response.ok) return classifyResponse(response);

					const parsed = await parseSuccessfulResponse(
						response,
						enablePublicColumnResponseSchema,
						mutation.opType,
					);
					if (!parsed.ok) return parsed.result;
					const { publicId, url } = parsed.data;
					if (new URL(url).pathname !== `/p/${publicId}`) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [
							{
								type: "column.public.enabled",
								queueId: mutation.queueId,
								columnId,
								publicLink: { publicId, url },
							},
						],
					};
				}

				case "column.public.disable": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const response = await fetchRequest(`/api/column/${columnId}/public`, {
						method: "DELETE",
						signal,
						headers: {
							...testHeaders,
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
					});
					if (!response.ok) return classifyResponse(response);
					const parsed = await parseSuccessfulResponse(
						response,
						disablePublicColumnResponseSchema,
						mutation.opType,
					);
					return parsed.ok
						? {
								kind: "ack",
								effects: [{ type: "column.public.disabled", columnId }],
							}
						: parsed.result;
				}
			}
		},
	};
}
