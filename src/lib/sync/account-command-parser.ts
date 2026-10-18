import { ACCOUNT_COMMANDS, isAccountCommandType } from "../api/account-commands";
import type { QueuedMutation } from "./contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

interface ParsedQueueFields {
	queueId: string;
	idempotencyKey: string;
	entityId: string;
	createdAt: number;
	attemptCount: number;
	nextRetryAt: number;
	lastError?: string;
}

function parseQueueFields(value: Record<string, unknown>): ParsedQueueFields | null {
	if (
		!isNonEmptyString(value.queueId) ||
		!isNonEmptyString(value.idempotencyKey) ||
		!isNonEmptyString(value.entityId) ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		typeof value.attemptCount !== "number" ||
		!Number.isInteger(value.attemptCount) ||
		value.attemptCount < 0 ||
		typeof value.nextRetryAt !== "number" ||
		!Number.isFinite(value.nextRetryAt) ||
		!(
			value.lastError === undefined ||
			value.lastError === null ||
			typeof value.lastError === "string"
		)
	) {
		return null;
	}

	return {
		queueId: value.queueId,
		idempotencyKey: value.idempotencyKey,
		entityId: value.entityId,
		createdAt: value.createdAt,
		attemptCount: value.attemptCount,
		nextRetryAt: value.nextRetryAt,
		...(typeof value.lastError === "string"
			? { lastError: value.lastError }
			: {}),
	};
}

/** Parse the only untyped command boundary: data loaded from persisted outboxes. */
export function parseQueuedMutation(value: unknown): QueuedMutation | null {
	if (!isRecord(value) || !isAccountCommandType(value.opType)) return null;
	const fields = parseQueueFields(value);
	if (!fields) return null;

	const payload = ACCOUNT_COMMANDS[value.opType].payload.safeParse(value.payload);
	if (!payload.success) return null;
	return {
		...fields,
		opType: value.opType,
		payload: payload.data,
	} as QueuedMutation;
}
