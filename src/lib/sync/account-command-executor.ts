import { normalizeAccountId, validateAccountId } from "../account";
import type { ColumnMeta, PublicLinkResponse } from "../../types/account";
import type { QueuedMutation } from "./contracts";
import type { MutationReplayResult } from "./mutation-queue-service";
import { mutationResultFromResponse } from "./replay-response";

export type AccountCommandEffect =
	| { type: "column.created"; queueId: string; column: ColumnMeta }
	| { type: "column.deleted"; columnId: string }
	| { type: "column.sharing.updated"; columnId: string; sharedWith: string[] }
	| {
			type: "column.public.enabled";
			queueId: string;
			columnId: string;
			publicLink: PublicLinkResponse;
	  }
	| { type: "column.public.disabled"; columnId: string };

export type AccountCommandExecutionResult = MutationReplayResult & {
	effects?: AccountCommandEffect[];
};

export interface AccountCommandExecutor {
	execute(mutation: QueuedMutation): Promise<AccountCommandExecutionResult>;
}

interface AccountCommandExecutorOptions {
	getActiveAccountId(): string | null;
	fetch?: typeof globalThis.fetch;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((item) => typeof item === "string")) return null;
	return value;
}

function invalidPayload(error: string): AccountCommandExecutionResult {
	return { kind: "drop", reason: "validation_failed", error };
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
		async execute(mutation) {
			const activeAccountId = options.getActiveAccountId();
			if (!activeAccountId) {
				return { kind: "retry", error: "No active account session" };
			}

			const normalizedActiveAccountId = normalizeAccountId(activeAccountId);
			if (normalizedActiveAccountId !== normalizeAccountId(mutation.entityId)) {
				return {
					kind: "retry",
					error: "Active session does not match queued command account",
				};
			}

			switch (mutation.opType) {
				case "column.create": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");

					const response = await fetchRequest("/api/column", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
						body: JSON.stringify({ accountId: activeAccountId, columnId }),
					});
					if (!response.ok) return classifyResponse(response);

					const payload = (await response.json()) as { column?: ColumnMeta };
					const effects =
						payload.column?.id === columnId
							? ([
									{
										type: "column.created",
										queueId: mutation.queueId,
										column: payload.column,
									},
								] satisfies AccountCommandEffect[])
							: [];
					return { kind: "ack", effects };
				}

				case "column.reorder": {
					const { columnOrder } = mutation.payload;
					return classifyResponse(
						await fetchRequest(
							`/api/account/${normalizedActiveAccountId}/columns`,
							{
								method: "PUT",
								headers: {
									"Content-Type": "application/json",
									"X-Idempotency-Key": mutation.idempotencyKey,
								},
								body: JSON.stringify({ columnOrder }),
							},
						),
					);
				}

				case "column.hide_shared": {
					const { hiddenSharedColumns } = mutation.payload;
					return classifyResponse(
						await fetchRequest(
							`/api/account/${normalizedActiveAccountId}/hidden`,
							{
								method: "PUT",
								headers: {
									"Content-Type": "application/json",
									"X-Idempotency-Key": mutation.idempotencyKey,
								},
								body: JSON.stringify({ hiddenSharedColumns }),
							},
						),
					);
				}

				case "column.delete": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const result = await classifyResponse(
						await fetchRequest(`/api/column/${columnId}`, {
							method: "DELETE",
							headers: {
								"X-Account-ID": activeAccountId,
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
						}),
					);
					return result.kind === "ack"
						? { ...result, effects: [{ type: "column.deleted", columnId }] }
						: result;
				}

				case "column.restore": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					return classifyResponse(
						await fetchRequest(`/api/column/${columnId}/restore`, {
							method: "POST",
							headers: {
								"X-Account-ID": activeAccountId,
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
						}),
					);
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
						isShare
							? `/api/column/${columnId}/share`
							: `/api/column/${columnId}/share/${normalizeAccountId(targetAccountId)}`,
						{
							method: isShare ? "POST" : "DELETE",
							headers: {
								...(isShare ? { "Content-Type": "application/json" } : {}),
								"X-Account-ID": activeAccountId,
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
							...(isShare
								? { body: JSON.stringify({ targetAccountId }) }
								: {}),
						},
					);
					if (!response.ok) return classifyResponse(response);

					const payload = (await response.json()) as { sharedWith?: unknown };
					const sharedWith = asStringArray(payload.sharedWith);
					return {
						kind: "ack",
						effects: sharedWith
							? [{ type: "column.sharing.updated", columnId, sharedWith }]
							: [],
					};
				}

				case "column.public.enable": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const response = await fetchRequest(`/api/column/${columnId}/public`, {
						method: "POST",
						headers: {
							"X-Account-ID": activeAccountId,
							"X-Idempotency-Key": mutation.idempotencyKey,
						},
					});
					if (!response.ok) return classifyResponse(response);

					const payload = (await response.json()) as Partial<PublicLinkResponse>;
					const publicId = asString(payload.publicId);
					const url = asString(payload.url);
					return {
						kind: "ack",
						effects:
							publicId && url
								? [
										{
											type: "column.public.enabled",
											queueId: mutation.queueId,
											columnId,
											publicLink: { publicId, url },
										},
									]
								: [],
					};
				}

				case "column.public.disable": {
					const { columnId } = mutation.payload;
					if (!columnId) return invalidPayload("Invalid columnId payload");
					const result = await classifyResponse(
						await fetchRequest(`/api/column/${columnId}/public`, {
							method: "DELETE",
							headers: {
								"X-Account-ID": activeAccountId,
								"X-Idempotency-Key": mutation.idempotencyKey,
							},
						}),
					);
					return result.kind === "ack"
						? {
								...result,
								effects: [{ type: "column.public.disabled", columnId }],
							}
						: result;
				}
			}
		},
	};
}
