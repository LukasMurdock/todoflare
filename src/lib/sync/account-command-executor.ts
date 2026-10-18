import { normalizeAccountId } from "../account";
import {
	ACCOUNT_COMMANDS,
	accountCommandUrl,
	type AccountCommandResponse,
	type AccountCommandType,
} from "../api/account-commands";
import type {
	AccountCommandEffect,
	QueuedMutation,
} from "./contracts";
import type { MutationReplayResult } from "./mutation-queue-service";
import { mutationResultFromResponse } from "./replay-response";
import { accountRequestHeaders } from "../account-request-headers";

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

type SendOutcome<T extends AccountCommandType> =
	| { ok: true; data: AccountCommandResponse<T> }
	| { ok: false; result: AccountCommandExecutionResult };

function invalidSuccessfulResponse(
	operation: QueuedMutation["opType"],
): AccountCommandExecutionResult {
	return {
		kind: "retry",
		error: `Invalid successful response for ${operation}`,
	};
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

export function createAccountCommandExecutor(
	options: AccountCommandExecutorOptions,
): AccountCommandExecutor {
	const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);

	/** Sends a command over the HTTP route its registry entry declares. */
	async function send<T extends AccountCommandType>(
		mutation: QueuedMutation<T>,
		signal: AbortSignal | undefined,
	): Promise<SendOutcome<T>> {
		const definition = ACCOUNT_COMMANDS[mutation.opType as AccountCommandType];
		const payload = definition.payload.safeParse(mutation.payload);
		if (!payload.success) {
			return {
				ok: false,
				result: {
					kind: "drop",
					reason: "validation_failed",
					error: `Invalid ${mutation.opType} payload`,
				},
			};
		}

		const request = (
			definition.request as (payload: unknown) => { id?: string; body?: unknown }
		)(payload.data);
		const hasBody = request.body !== undefined;
		const response = await fetchRequest(accountCommandUrl(definition.path, request.id), {
			method: definition.method,
			signal,
			headers: {
				...accountRequestHeaders(mutation.entityId),
				...(hasBody ? { "Content-Type": "application/json" } : {}),
				"X-Idempotency-Key": mutation.idempotencyKey,
			},
			...(hasBody ? { body: JSON.stringify(request.body) } : {}),
		});
		if (!response.ok) {
			return { ok: false, result: await mutationResultFromResponse(response) };
		}

		const body = await response
			.clone()
			.json()
			.catch(() => null);
		const parsed = definition.response.safeParse(body);
		return parsed.success
			? { ok: true, data: parsed.data as AccountCommandResponse<T> }
			: { ok: false, result: invalidSuccessfulResponse(mutation.opType) };
	}

	return {
		async execute(mutation, executionOptions) {
			const activeAccountId = mutation.entityId;
			const signal = executionOptions?.signal;

			switch (mutation.opType) {
				case "column.create": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					const { column } = sent.data;
					if (!isExpectedColumn(column, mutation.payload.columnId, activeAccountId)) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [{ type: "column.created", queueId: mutation.queueId, column }],
					};
				}

				case "column.reorder":
				case "column.hide_shared": {
					const sent = await send(mutation, signal);
					return sent.ok ? { kind: "ack" } : sent.result;
				}

				case "column.delete": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					return {
						kind: "ack",
						effects: [{ type: "column.deleted", columnId: mutation.payload.columnId }],
					};
				}

				case "column.restore": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					return isExpectedColumn(sent.data.column, mutation.payload.columnId, activeAccountId)
						? { kind: "ack" }
						: invalidSuccessfulResponse(mutation.opType);
				}

				case "column.share":
				case "column.revoke": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					const { columnId, targetAccountId } = mutation.payload;
					const normalizedTarget = normalizeAccountId(targetAccountId);
					const containsTarget = sent.data.sharedWith.some(
						(accountId) => normalizeAccountId(accountId) === normalizedTarget,
					);
					if (containsTarget !== (mutation.opType === "column.share")) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [
							{
								type: "column.sharing.updated",
								columnId,
								sharedWith: sent.data.sharedWith,
							},
						],
					};
				}

				case "column.public.enable": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					const { publicId, url } = sent.data;
					if (new URL(url).pathname !== `/p/${publicId}`) {
						return invalidSuccessfulResponse(mutation.opType);
					}
					return {
						kind: "ack",
						effects: [
							{
								type: "column.public.enabled",
								queueId: mutation.queueId,
								columnId: mutation.payload.columnId,
								publicLink: { publicId, url },
							},
						],
					};
				}

				case "column.public.disable": {
					const sent = await send(mutation, signal);
					if (!sent.ok) return sent.result;
					return {
						kind: "ack",
						effects: [{ type: "column.public.disabled", columnId: mutation.payload.columnId }],
					};
				}
			}
		},
	};
}
