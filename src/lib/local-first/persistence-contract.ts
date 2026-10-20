import { z } from "zod";
import {
	accountContractSchema,
	accountIdContractSchema,
	columnMetaContractSchema,
	deletedColumnContractSchema,
	publicLinkContractSchema,
} from "../api/account-contract";
import { parseQueuedMutation } from "../sync/account-command-parser";
import { ACCOUNT_COMMAND_TYPES, TERMINAL_REPLAY_REASONS } from "../sync/contracts";
import { SYNC_MODES } from "../sync/mode-machine";
import {
	YJS_OUTBOX_KINDS,
	type AccountSnapshotDoc,
	type ColumnDocumentDoc,
	type DurableCollectionName,
	type MutationOutboxDoc,
	type QuarantinedRecord,
	type SyncStateDoc,
	type YjsUpdateOutboxDoc,
} from "./collections";

/** Rejected commands kept in the sync state for diagnosis. */
export const MAX_RECENT_SYNC_FAILURES = 20;
const finiteNumber = z.number().finite();
const nonNegativeInteger = z.number().int().nonnegative();
const nullableFiniteNumber = finiteNumber.nullable();
const terminalReasonSchema = z.enum(TERMINAL_REPLAY_REASONS).nullable();

const accountSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().min(1),
		accountId: z.string().min(1),
		account: accountContractSchema,
		sharedColumns: z.array(columnMetaContractSchema),
		deletedColumns: z.array(deletedColumnContractSchema),
		sharedWithByColumn: z
			.record(
				z.string(),
				z.union([z.array(accountIdContractSchema), z.undefined()]),
			)
			.optional(),
		publicLinksByColumn: z
			.record(z.string(), z.union([publicLinkContractSchema, z.null()]))
			.optional(),
		hydratedAt: finiteNumber,
		reconciledAt: nullableFiniteNumber,
	})
	.strict();

const byteArraySchema = z.array(z.number().int().min(0).max(255));
const columnDocumentSchema = z.object({
	schemaVersion: z.literal(1), id: z.string().min(1),
	accountId: z.string().min(1), columnId: z.string().min(1), updateBytes: byteArraySchema,
}).strict();
const yjsUpdateOutboxSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().min(1),
		accountId: z.string().min(1),
		columnId: z.string().min(1),
		kind: z.enum(YJS_OUTBOX_KINDS),
		updateBytes: byteArraySchema,
		stateVectorBytes: byteArraySchema.nullable(),
		createdAt: finiteNumber,
		attemptCount: nonNegativeInteger,
		nextRetryAt: finiteNumber,
		ackedAt: nullableFiniteNumber,
		terminalReason: terminalReasonSchema,
		lastError: z.string().nullable(),
	})
	.strict();

const syncStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().min(1),
		accountId: z.string().nullable(),
		mode: z.enum(SYNC_MODES),
		queueDepth: nonNegativeInteger,
		yjsQueueDepth: nonNegativeInteger,
		lastServerHydrationAt: nullableFiniteNumber,
		lastReplayAt: nullableFiniteNumber,
		lastReplayLatencyMs: nullableFiniteNumber,
		revokeDiscardCount: nonNegativeInteger,
		convergenceFailureCount: nonNegativeInteger,
		recentSyncFailures: z
			.array(
				z
					.object({
						failedAt: finiteNumber,
						opType: z.enum(ACCOUNT_COMMAND_TYPES),
						columnId: z.string().nullable(),
						reason: z.enum(TERMINAL_REPLAY_REASONS),
						status: nonNegativeInteger.nullable(),
						code: z.string().nullable(),
						message: z.string().nullable(),
					})
					.strict(),
			)
			.max(MAX_RECENT_SYNC_FAILURES)
			.optional(),
		updatedAt: finiteNumber,
	})
	.strict();

/**
 * Each schema is checked against its document interface in collections.ts, so
 * a field added to the interface but not the schema is a compile error.
 */
const currentSchemas = {
	accountSnapshot: accountSnapshotSchema,
	columnDocument: columnDocumentSchema,
	yjsUpdateOutbox: yjsUpdateOutboxSchema,
	syncState: syncStateSchema,
} satisfies {
	accountSnapshot: z.ZodType<AccountSnapshotDoc>;
	columnDocument: z.ZodType<ColumnDocumentDoc>;
	yjsUpdateOutbox: z.ZodType<YjsUpdateOutboxDoc>;
	syncState: z.ZodType<SyncStateDoc>;
};

type PersistedDoc =
	| ColumnDocumentDoc
	| AccountSnapshotDoc
	| MutationOutboxDoc
	| YjsUpdateOutboxDoc
	| SyncStateDoc;

export interface MigratedCollection {
	entries: Array<[string, PersistedDoc]>;
	quarantined: QuarantinedRecord[];
	changed: boolean;
	writeBlocked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function issueMessage(error: z.ZodError): string {
	return error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
		.join("; ");
}

function foundVersion(raw: unknown): number | null {
	if (!isRecord(raw) || typeof raw.schemaVersion !== "number") return null;
	return raw.schemaVersion;
}

function migrateLegacy(
	collection: DurableCollectionName,
	raw: Record<string, unknown>,
): Record<string, unknown> {
	switch (collection) {
		case "accountSnapshot":
			return {
				...raw,
				schemaVersion: 1,
				sharedWithByColumn: raw.sharedWithByColumn ?? {},
				publicLinksByColumn: raw.publicLinksByColumn ?? {},
			};
		case "columnDocument":
		case "mutationOutbox":
		case "yjsUpdateOutbox":
		case "syncState":
			return { ...raw, schemaVersion: 1 };
	}
}

function parseMutationOutbox(raw: unknown): MutationOutboxDoc | null {
	if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
	const queued = parseQueuedMutation(raw);
	if (!queued) return null;
	if (raw.id !== queued.queueId) return null;
	if (raw.ackedAt !== null) return null;
	if (raw.lastError !== null && typeof raw.lastError !== "string") return null;
	if (terminalReasonSchema.safeParse(raw.terminalReason).success === false) return null;
	if (raw.lastAttemptAt !== null && !finiteNumber.safeParse(raw.lastAttemptAt).success) {
		return null;
	}
	if (!finiteNumber.safeParse(raw.insertedAt).success) return null;

	return {
		schemaVersion: 1,
		id: queued.queueId,
		queueId: queued.queueId,
		idempotencyKey: queued.idempotencyKey,
		opType: queued.opType,
		entityId: queued.entityId,
		payload: queued.payload,
		createdAt: queued.createdAt,
		attemptCount: queued.attemptCount,
		nextRetryAt: queued.nextRetryAt,
		ackedAt: null,
		lastError: typeof raw.lastError === "string" ? raw.lastError : null,
		terminalReason: raw.terminalReason as MutationOutboxDoc["terminalReason"],
		lastAttemptAt: raw.lastAttemptAt as number | null,
		insertedAt: raw.insertedAt as number,
	};
}

function parseCurrent(
	collection: DurableCollectionName,
	raw: unknown,
): { value: PersistedDoc | null; reason: string } {
	if (collection === "mutationOutbox") {
		const value = parseMutationOutbox(raw);
		return { value, reason: value ? "" : "record: invalid queued mutation" };
	}

	const schema = currentSchemas[collection];
	const parsed = schema.safeParse(raw);
	return parsed.success
		? { value: parsed.data as PersistedDoc, reason: "" }
		: { value: null, reason: issueMessage(parsed.error) };
}

function quarantine(
	collection: DurableCollectionName,
	key: string,
	raw: unknown,
	category: QuarantinedRecord["category"],
	reason: string,
	now: number,
): QuarantinedRecord {
	return {
		schemaVersion: 1,
		id: `quarantine:${collection}:${encodeURIComponent(key)}:${category}:v${foundVersion(raw) ?? 0}`,
		sourceCollection: collection,
		sourceKey: key,
		detectedAt: now,
		category,
		foundVersion: foundVersion(raw),
		reason,
		containsDurableMutation:
			collection === "mutationOutbox" || collection === "yjsUpdateOutbox",
		raw,
	};
}

/** Validates and upgrades one collection before application code can observe it. */
export function migrateCollectionEntries(
	collection: DurableCollectionName,
	rawEntries: Array<[string, unknown]>,
	now = Date.now(),
): MigratedCollection {
	const entries: Array<[string, PersistedDoc]> = [];
	const quarantined: QuarantinedRecord[] = [];
	let changed = false;
	let writeBlocked = false;

	for (const [key, original] of rawEntries) {
		const version = foundVersion(original);
		if (version !== null && version > 1) {
			quarantined.push(
				quarantine(
					collection,
					key,
					original,
					"unsupported_version",
					`schemaVersion ${version} is newer than supported version 1`,
					now,
				),
			);
			writeBlocked = true;
			continue;
		}

		if (version !== null && version !== 1) {
			quarantined.push(
				quarantine(
					collection,
					key,
					original,
					"migration_failed",
					`schemaVersion ${version} has no migration path`,
					now,
				),
			);
			changed = true;
			continue;
		}

		const candidate =
			version === null && isRecord(original)
				? migrateLegacy(collection, original)
				: original;
		const parsed = parseCurrent(collection, candidate);
		if (!parsed.value) {
			quarantined.push(
				quarantine(collection, key, original, "invalid", parsed.reason, now),
			);
			changed = true;
			continue;
		}

		if (parsed.value.id !== key) {
			quarantined.push(
				quarantine(
					collection,
					key,
					original,
					"invalid",
					`map key does not match document id ${parsed.value.id}`,
					now,
				),
			);
			changed = true;
			continue;
		}

		entries.push([key, parsed.value]);
		changed ||= version === null;
	}

	return { entries, quarantined, changed, writeBlocked };
}
