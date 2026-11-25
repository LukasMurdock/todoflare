import { z } from "zod";
import { accountCommandContracts, isAccountCommandType } from "../api/account-commands";
import type { AccountCommandType } from "../api/account-commands";
import { createAccountEditCommand } from "./contracts";
import type { QueuedMutation } from "./contracts";

const queueFields = z.object({
	queueId: z.string().min(1),
	idempotencyKey: z.string().min(1),
	entityId: z.string().min(1),
	createdAt: z.number().finite(),
	attemptCount: z.number().nonnegative().refine(Number.isInteger),
	nextRetryAt: z.number().finite(),
	lastError: z.string().nullish(),
	opType: z.custom<AccountCommandType>(isAccountCommandType),
	payload: z.unknown(),
});

/** Parse the only untyped command boundary: data loaded from persisted outboxes. */
export function parseQueuedMutation(value: unknown): QueuedMutation | null {
	const parsed = queueFields.safeParse(value);
	if (!parsed.success) {return null;}
	const { opType, payload, lastError, ...fields } = parsed.data;
	const command = parsePayload(opType, fields, payload);
	if (command && typeof lastError === "string") { command.lastError = lastError; }
	return command;
}

function parsePayload<T extends AccountCommandType>(
	opType: T,
	fields: Omit<z.output<typeof queueFields>, "opType" | "payload" | "lastError">,
	raw: unknown,
): QueuedMutation<T> | null {
	const payload = accountCommandContracts[opType].payload.safeParse(raw);
	if (!payload.success) {return null;}
	return { ...createAccountEditCommand(opType, payload.data, fields), queueId: fields.queueId };
}
