import { isStoredQuarantineRecord, isRecord } from "./persistence-contract";
import type {
	DurableCollectionName,
	QuarantinedRecord,
	StoredQuarantineRecord,
} from "./collections";

export const LOCAL_STORAGE_QUARANTINE_SUFFIX = ":quarantine-v1";

function persistQuarantine(
	storageKey: string,
	collection: DurableCollectionName,
	invalid: Array<{
		index: number;
		raw: unknown;
		category: QuarantinedRecord["category"];
		reason: string;
	}>,
): void {
	if (invalid.length === 0 || typeof window === "undefined") {return;}
	const quarantineKey = `${storageKey}${LOCAL_STORAGE_QUARANTINE_SUFFIX}`;
	try {
		const existingRaw = window.localStorage.getItem(quarantineKey);
		const parsedExisting: unknown = existingRaw ? JSON.parse(existingRaw) : [];
		const existing: Array<unknown> = Array.isArray(parsedExisting) ? parsedExisting : [];
		const byId = new Map<string, StoredQuarantineRecord>();
		const unrecognized: Array<unknown> = [];
		for (const record of existing) {
			if (isStoredQuarantineRecord(record)) { byId.set(record.id, record); }
			else { unrecognized.push(record); }
		}
		for (const item of invalid) {
			const version =
				isRecord(item.raw) && typeof item.raw.schemaVersion === "number"
					? item.raw.schemaVersion
					: null;
			const id = `local-storage:${collection}:${item.index}:${item.category}:v${version ?? 0}`;
			byId.set(id, {
				schemaVersion: 1,
				id,
				sourceCollection: collection,
				sourceKey: String(item.index),
				detectedAt: Date.now(),
				category: item.category,
				foundVersion: version,
				reason: item.reason,
				containsDurableMutation: true,
				raw: item.raw,
			});
		}
		window.localStorage.setItem(
			quarantineKey,
			JSON.stringify([...unrecognized, ...byId.values()]),
		);
		console.error(
			`Quarantined ${invalid.length} invalid ${collection} localStorage record(s).`,
		);
	} catch (error) {
		console.error(
			`Failed to quarantine invalid ${collection} localStorage records.`,
			error,
		);
	}
}

export function readVersionedLocalStorageArray<T>(params: {
	storageKey: string;
	collection: "mutationOutbox" | "yjsUpdateOutbox";
	parse: (raw: unknown) => T | null;
}) {
	if (typeof window === "undefined") {return { records: [], writeBlocked: false };}
	try {
		const rawText = window.localStorage.getItem(params.storageKey);
		if (!rawText) {return { records: [], writeBlocked: false };}
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawText);
		} catch {
			persistQuarantine(params.storageKey, params.collection, [
				{
					index: 0,
					raw: rawText,
					category: "invalid",
					reason: "storage value is not valid JSON",
				},
			]);
			return { records: [], writeBlocked: false };
		}
		if (!Array.isArray(parsed)) {
			persistQuarantine(params.storageKey, params.collection, [
				{
					index: 0,
					raw: parsed,
					category: "invalid",
					reason: "storage value is not an array",
				},
			]);
			return { records: [], writeBlocked: false };
		}

		const records: Array<T> = [];
		const invalid: Parameters<typeof persistQuarantine>[2] = [];
		let writeBlocked = false;
		parsed.forEach((raw, index) => {
			const version =
				isRecord(raw) && typeof raw.schemaVersion === "number"
					? raw.schemaVersion
					: null;
			if (version !== null && version > 1) {
				writeBlocked = true;
				invalid.push({
					index,
					raw,
					category: "unsupported_version",
					reason: `schemaVersion ${version} is newer than supported version 1`,
				});
				return;
			}
			if (version !== null && version !== 1) {
				invalid.push({
					index,
					raw,
					category: "migration_failed",
					reason: `schemaVersion ${version} has no migration path`,
				});
				return;
			}
			const record = params.parse(raw);
			if (record) {records.push(record);}
			else {
				invalid.push({
					index,
					raw,
					category: "invalid",
					reason: "record validation failed",
				});
			}
		});
		persistQuarantine(params.storageKey, params.collection, invalid);
		return { records, writeBlocked };
	} catch (error) {
		console.error(`Failed to read ${params.collection} localStorage records.`, error);
		return { records: [], writeBlocked: false };
	}
}

export function readAllLocalStorageQuarantine(): Array<StoredQuarantineRecord> {
	if (typeof window === "undefined") {return [];}
	const byId = new Map<string, StoredQuarantineRecord>();
	try {
		for (let index = 0; index < window.localStorage.length; index += 1) {
			const key = window.localStorage.key(index);
			if (!key?.endsWith(LOCAL_STORAGE_QUARANTINE_SUFFIX)) {continue;}
			const raw = window.localStorage.getItem(key);
			if (!raw) {continue;}
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {continue;}
			for (const value of parsed) {
				if (isStoredQuarantineRecord(value)) { byId.set(value.id, value); }
			}
		}
	} catch (error) {
		console.error("Failed to read localStorage quarantine records.", error);
	}
	return Array.from(byId.values());
}
