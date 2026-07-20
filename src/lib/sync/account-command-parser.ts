import { validateAccountId } from "../account";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
	QueuedMutation,
} from "./contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function queuedMutation<T extends AccountCommandType>(
	fields: ParsedQueueFields,
	opType: T,
	payload: AccountCommandPayloadMap[T],
): QueuedMutation<T> {
	return { ...fields, opType, payload } as unknown as QueuedMutation<T>;
}

/** Parse the only untyped command boundary: data loaded from persisted outboxes. */
export function parseQueuedMutation(value: unknown): QueuedMutation | null {
	if (!isRecord(value) || !isRecord(value.payload)) return null;
	const fields = parseQueueFields(value);
	if (!fields) return null;

	switch (value.opType) {
		case "column.create":
		case "column.delete":
		case "column.restore":
		case "column.public.enable":
		case "column.public.disable":
			return isNonEmptyString(value.payload.columnId)
				? queuedMutation(fields, value.opType, {
						columnId: value.payload.columnId,
					})
				: null;

		case "column.reorder":
			return isStringArray(value.payload.columnOrder)
				? queuedMutation(fields, value.opType, {
						columnOrder: [...value.payload.columnOrder],
					})
				: null;

		case "column.hide_shared":
			return isStringArray(value.payload.hiddenSharedColumns)
				? queuedMutation(fields, value.opType, {
						hiddenSharedColumns: [...value.payload.hiddenSharedColumns],
					})
				: null;

		case "column.share":
		case "column.revoke":
			return isNonEmptyString(value.payload.columnId) &&
				isNonEmptyString(value.payload.targetAccountId) &&
				validateAccountId(value.payload.targetAccountId)
				? queuedMutation(fields, value.opType, {
						columnId: value.payload.columnId,
						targetAccountId: value.payload.targetAccountId,
					})
				: null;

		default:
			return null;
	}
}
