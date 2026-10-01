import type { YjsUpdateOutboxDoc } from "@/lib/local-first/collections";
import {
	replaceLocalFirstCollection,
	type LocalFirstDatabase,
} from "../local-first/database";
import { createOutboxJournal } from "../local-first/outbox-journal";

const DEFAULT_STORAGE_KEY = "todoflare-yjs-update-outbox-v1";
const DEFAULT_AWARENESS_MAX_AGE_MS = 30_000;

export type YjsOutboxKind = "sync" | "awareness";

export interface YjsOutboxEntry extends Omit<YjsUpdateOutboxDoc, "schemaVersion"> {}

export interface YjsOutboxStorage {
	read(): YjsOutboxEntry[];
	write(entries: YjsOutboxEntry[]): void;
}

export interface EnqueueYjsOutboxInput {
	accountId: string;
	columnId: string;
	kind: YjsOutboxKind;
	payload: Uint8Array;
}

function byCreatedAt(a: YjsOutboxEntry, b: YjsOutboxEntry): number {
	if (a.createdAt === b.createdAt) {
		return a.id.localeCompare(b.id);
	}
	return a.createdAt - b.createdAt;
}

function cloneEntries(entries: YjsOutboxEntry[]): YjsOutboxEntry[] {
	return entries.map((entry) => ({
		...entry,
		updateBytes: [...entry.updateBytes],
		stateVectorBytes: entry.stateVectorBytes ? [...entry.stateVectorBytes] : null,
	}));
}

function mergeEntriesById(
	baseEntries: YjsOutboxEntry[],
	overrideEntries: YjsOutboxEntry[],
): YjsOutboxEntry[] {
	const merged = new Map<string, YjsOutboxEntry>();

	for (const entry of baseEntries) {
		merged.set(entry.id, { ...entry });
	}

	for (const entry of overrideEntries) {
		merged.set(entry.id, { ...entry });
	}

	return cloneEntries(Array.from(merged.values()).sort(byCreatedAt));
}

function isValidKind(value: unknown): value is YjsOutboxKind {
	return value === "sync" || value === "awareness";
}

function normalizeEntry(raw: unknown): YjsOutboxEntry | null {
	if (!raw || typeof raw !== "object") return null;

	const candidate = raw as Partial<YjsOutboxEntry>;
	if (typeof candidate.id !== "string") return null;
	if (typeof candidate.accountId !== "string") return null;
	if (typeof candidate.columnId !== "string") return null;
	if (!isValidKind(candidate.kind)) return null;
	if (!Array.isArray(candidate.updateBytes)) return null;
	if (!candidate.updateBytes.every((item) => typeof item === "number")) {
		return null;
	}
	if (
		candidate.stateVectorBytes !== null &&
		candidate.stateVectorBytes !== undefined &&
		(!Array.isArray(candidate.stateVectorBytes) ||
			!candidate.stateVectorBytes.every((item) => typeof item === "number"))
	) {
		return null;
	}
	if (typeof candidate.createdAt !== "number") return null;
	if (typeof candidate.attemptCount !== "number") return null;
	if (typeof candidate.nextRetryAt !== "number") return null;
	if (candidate.ackedAt !== null && typeof candidate.ackedAt !== "number") {
		return null;
	}
	if (
		candidate.terminalReason !== null &&
		candidate.terminalReason !== undefined &&
		typeof candidate.terminalReason !== "string"
	) {
		return null;
	}
	if (candidate.lastError !== null && typeof candidate.lastError !== "string") {
		return null;
	}

	return {
		id: candidate.id,
		accountId: candidate.accountId,
		columnId: candidate.columnId,
		kind: candidate.kind,
		updateBytes: [...candidate.updateBytes],
		stateVectorBytes: candidate.stateVectorBytes
			? [...candidate.stateVectorBytes]
			: null,
		createdAt: candidate.createdAt,
		attemptCount: candidate.attemptCount,
		nextRetryAt: candidate.nextRetryAt,
		ackedAt: candidate.ackedAt ?? null,
		terminalReason: candidate.terminalReason ?? null,
		lastError: candidate.lastError ?? null,
	};
}

export class LocalYjsUpdateOutbox {
	private entries: YjsOutboxEntry[];
	private storage: YjsOutboxStorage;
	private readonly journal: YjsOutboxStorage;
	private readonly onPersistenceError?: (error: unknown) => void;

	constructor(options?: { storage?: YjsOutboxStorage; onPersistenceError?: (error: unknown) => void }) {
		this.onPersistenceError = options?.onPersistenceError;
		this.storage =
			options?.storage ??
			createLocalStorageYjsOutboxStorage(DEFAULT_STORAGE_KEY);
		this.journal = this.storage;
		this.entries = this.storage.read().sort(byCreatedAt);
	}

	swapStorage(storage: YjsOutboxStorage) {
		const synchronousMirror = this.journal;
		const persistedEntries = storage.read().sort(byCreatedAt);
		this.storage = {
			read: () => storage.read(),
			write: (entries) => {
				// Keep the original localStorage-backed writer as a synchronous
				// crash/refresh journal while IndexedDB persistence catches up.
				storage.write(entries);
				synchronousMirror.write(entries);
			},
		};
		this.entries = mergeEntriesById(persistedEntries, this.entries).sort(byCreatedAt);
		this.persist();
	}

	getAllEntries(): YjsOutboxEntry[] {
		return cloneEntries(this.entries);
	}

	enqueue(input: EnqueueYjsOutboxInput): string {
		const now = Date.now();

		if (input.kind === "awareness") {
			this.entries = this.entries.filter(
				(entry) =>
					!(
						entry.accountId === input.accountId &&
						entry.columnId === input.columnId &&
						entry.kind === "awareness"
					),
			);
		}

		const id = crypto.randomUUID();
		this.entries.push({
			id,
			accountId: input.accountId,
			columnId: input.columnId,
			kind: input.kind,
			updateBytes: Array.from(input.payload),
			stateVectorBytes: null,
			createdAt: now,
			attemptCount: 0,
			nextRetryAt: now,
			ackedAt: null,
			terminalReason: null,
			lastError: null,
		});

		this.persist();
		return id;
	}

	getReplayableForColumn(
		accountId: string,
		columnId: string,
		options?: { awarenessMaxAgeMs?: number },
	): YjsOutboxEntry[] {
		const awarenessMaxAgeMs =
			options?.awarenessMaxAgeMs ?? DEFAULT_AWARENESS_MAX_AGE_MS;
		const now = Date.now();
		const replayable: YjsOutboxEntry[] = [];
		let changed = false;

		this.entries = this.entries.filter((entry) => {
			if (entry.accountId !== accountId || entry.columnId !== columnId) {
				return true;
			}

			if (
				entry.kind === "awareness" &&
				now - entry.createdAt > awarenessMaxAgeMs
			) {
				changed = true;
				return false;
			}

			replayable.push(entry);
			return true;
		});

		if (changed) {
			this.persist();
		}

		return cloneEntries(replayable.sort(byCreatedAt));
	}

	/** Removes ephemeral awareness entries after WebSocket.send() accepts them. */
	removeAwarenessAfterSocketWrite(entryIds: string[]): number {
		const ids = new Set(entryIds);
		if (ids.size === 0) return 0;

		const before = this.entries.length;
		this.entries = this.entries.filter(
			(entry) => entry.kind !== "awareness" || !ids.has(entry.id),
		);
		const removed = before - this.entries.length;

		if (removed > 0) {
			this.persist();
		}

		return removed;
	}

	/** Removes a sync update only after its Durable Object receipt arrives. */
	acknowledgeSync(
		accountId: string,
		columnId: string,
		outboxId: string,
	): boolean {
		const before = this.entries.length;
		this.entries = this.entries.filter(
			(entry) =>
				!(
					entry.id === outboxId &&
					entry.accountId === accountId &&
					entry.columnId === columnId &&
					entry.kind === "sync"
				),
		);

		if (this.entries.length === before) return false;
		this.persist();
		return true;
	}

	dropWhere(predicate: (entry: YjsOutboxEntry) => boolean): number {
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => !predicate(entry));
		const removed = before - this.entries.length;

		if (removed > 0) {
			this.persist();
		}

		return removed;
	}

	dropForColumn(accountId: string, columnId: string): number {
		return this.dropWhere(
			(entry) => entry.accountId === accountId && entry.columnId === columnId,
		);
	}

	pendingCountForColumn(accountId: string, columnId: string): number {
		return this.entries.filter(
			(entry) => entry.accountId === accountId && entry.columnId === columnId,
		).length;
	}

	clearAll() {
		if (this.entries.length === 0) return;
		this.entries = [];
		this.persist();
	}

	retryPersistence() { this.storage.write(this.entries); }

	private persist() {
		this.entries.sort(byCreatedAt);
		try { this.storage.write(this.entries); }
		catch (error) {
			if (!this.onPersistenceError) throw error;
			// Keep the actor alive so retained memory edits can still reach the
			// server. The UI callback immediately blocks further editing.
			this.onPersistenceError(error);
		}
	}
}

export function createLocalStorageYjsOutboxStorage(storageKey: string): YjsOutboxStorage {
	return createOutboxJournal({
		storageKey,
		collection: "yjsUpdateOutbox",
		parse: normalizeEntry,
		id: (entry) => entry.id,
	});
}

export function createMemoryYjsOutboxStorage(
	initialEntries: YjsOutboxEntry[] = [],
): YjsOutboxStorage {
	let entries = cloneEntries(initialEntries).sort(byCreatedAt);

	return {
		read() {
			return cloneEntries(entries);
		},
		write(nextEntries) {
			entries = cloneEntries(nextEntries).sort(byCreatedAt);
		},
	};
}

export function createLocalFirstYjsOutboxStorage(
	db: LocalFirstDatabase,
): YjsOutboxStorage {
	const collection = db.collections.yjsUpdateOutbox;

	return {
		read() {
			const entries = Array.from(collection.values())
				.map((entry) => normalizeEntry(entry))
				.filter((entry): entry is YjsOutboxEntry => entry !== null)
				.sort(byCreatedAt);

			return cloneEntries(entries);
		},
		write(entries) {
			replaceLocalFirstCollection(
				collection,
				entries.map((entry) => [
					entry.id,
					{
						schemaVersion: 1,
						id: entry.id,
					accountId: entry.accountId,
					columnId: entry.columnId,
					kind: entry.kind,
					updateBytes: [...entry.updateBytes],
					stateVectorBytes: entry.stateVectorBytes
						? [...entry.stateVectorBytes]
						: null,
					createdAt: entry.createdAt,
					attemptCount: entry.attemptCount,
					nextRetryAt: entry.nextRetryAt,
					ackedAt: entry.ackedAt,
					terminalReason: entry.terminalReason,
					lastError: entry.lastError,
					},
				] as const),
			);
		},
	};
}
