import type {
	AccountCommandEffect,
	AccountEditCommand,
	DropReason,
	MutationQueueService,
	ObservableLike,
	QueuedMutation,
	ReplayReport,
	TerminalReplayReason,
} from "@/lib/sync/contracts";
import {
	replaceLocalFirstCollection,
	type LocalFirstDatabase,
} from "../local-first/database";
import { parseQueuedMutation } from "./account-command-parser";
import { readVersionedLocalStorageArray } from "../local-first/local-storage-quarantine";

const DEFAULT_STORAGE_KEY = "todoflare-mutation-outbox-v1";
const BASE_BACKOFF_MS = 750;
const MAX_BACKOFF_MS = 30_000;
const JITTER_RATIO = 0.2;

export type MutationReplayResult =
	| { kind: "ack" }
	| { kind: "retry"; error?: string }
	| {
		kind: "drop";
		reason: TerminalReplayReason;
		error?: string;
	  };

export interface MutationQueueStorage {
	read(): QueuedMutation[];
	write(mutations: QueuedMutation[]): void;
}

export type MutationExecutor = (
	mutation: QueuedMutation,
	options?: { signal?: AbortSignal },
) => Promise<MutationReplayResult & { effects?: AccountCommandEffect[] }>;

function cloneMutations(mutations: QueuedMutation[]): QueuedMutation[] {
	return mutations.map((mutation) => ({ ...mutation }));
}

function mergeMutationsByQueueId(
	baseMutations: QueuedMutation[],
	overrideMutations: QueuedMutation[],
): QueuedMutation[] {
	const merged = new Map<string, QueuedMutation>();

	for (const mutation of baseMutations) {
		merged.set(mutation.queueId, { ...mutation });
	}

	for (const mutation of overrideMutations) {
		merged.set(mutation.queueId, { ...mutation });
	}

	return cloneMutations(Array.from(merged.values()).sort(byCreatedAt));
}

function computeRetryDelayMs(attemptCount: number): number {
	const exponential = Math.min(
		MAX_BACKOFF_MS,
		BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1)),
	);
	const jitter = Math.floor(exponential * JITTER_RATIO * Math.random());
	return exponential + jitter;
}

function byCreatedAt(a: QueuedMutation, b: QueuedMutation): number {
	if (a.createdAt === b.createdAt) {
		return a.queueId.localeCompare(b.queueId);
	}
	return a.createdAt - b.createdAt;
}

function toErrorMessage(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	return "Unknown replay error";
}

export class LocalMutationQueueService implements MutationQueueService {
	private queue: QueuedMutation[];
	private readonly subscribers = new Set<(value: QueuedMutation[]) => void>();
	private storage: MutationQueueStorage;
	private readonly executeMutation: MutationExecutor;

	constructor(options: {
		executor: MutationExecutor;
		storage?: MutationQueueStorage;
	}) {
		this.executeMutation = options.executor;
		this.storage =
			options.storage ?? createLocalStorageMutationQueueStorage(DEFAULT_STORAGE_KEY);
		this.queue = this.storage.read().sort(byCreatedAt);
	}

	async enqueue<T extends AccountEditCommand["opType"]>(
		cmd: AccountEditCommand<T>,
	): Promise<string> {
		const queueId = crypto.randomUUID();
		const queued: QueuedMutation = {
			...cmd,
			queueId,
		};
		this.queue = [...this.queue, queued].sort(byCreatedAt);
		this.persistAndPublish();
		return queueId;
	}

	swapStorage(storage: MutationQueueStorage) {
		const synchronousMirror = this.storage;
		const persistedMutations = storage.read().sort(byCreatedAt);
		this.storage = {
			read: () => storage.read(),
			write: (mutations) => {
				synchronousMirror.write(mutations);
				storage.write(mutations);
			},
		};
		this.queue = mergeMutationsByQueueId(persistedMutations, this.queue).sort(
			byCreatedAt,
		);
		this.persistAndPublish();
	}

	async replay(options: {
		accountId: string;
		signal?: AbortSignal;
		maxBatch?: number;
	}): Promise<ReplayReport> {
		const now = Date.now();
		const maxBatch = options.maxBatch ?? 50;
		const normalizedAccountId = options.accountId.replace(/\s/g, "");
		const eligible = this.queue
			.filter(
				(mutation) =>
					mutation.entityId.replace(/\s/g, "") === normalizedAccountId &&
					mutation.nextRetryAt <= now,
			)
			.sort(byCreatedAt)
			.slice(0, maxBatch);

		const report: ReplayReport = {
			attempted: 0,
			acked: 0,
			retried: 0,
			dropped: 0,
			ackedCommands: [],
			terminalFailures: [],
			effects: [],
		};

		for (const mutation of eligible) {
			if (options.signal?.aborted) break;
			report.attempted += 1;

			let result: MutationReplayResult & { effects?: AccountCommandEffect[] };
			try {
				result = await this.executeMutation(mutation, {
					signal: options.signal,
				});
			} catch (err) {
				if (options.signal?.aborted) break;
				result = { kind: "retry", error: toErrorMessage(err) };
			}
			if (options.signal?.aborted) break;

			const index = this.queue.findIndex((entry) => entry.queueId === mutation.queueId);
			if (index < 0) continue;

			if (result.kind === "ack") {
				this.queue.splice(index, 1);
				report.acked += 1;
				report.ackedCommands.push(mutation);
				report.effects.push(...(result.effects ?? []));
				continue;
			}

			if (result.kind === "drop") {
				this.queue.splice(index, 1);
				report.dropped += 1;
				report.terminalFailures.push({
					...mutation,
					reason: result.reason,
				} as (typeof report.terminalFailures)[number]);
				continue;
			}

			const nextAttemptCount = mutation.attemptCount + 1;
			const retryAt = now + computeRetryDelayMs(nextAttemptCount);
			this.queue[index] = {
				...mutation,
				attemptCount: nextAttemptCount,
				nextRetryAt: retryAt,
				lastError: result.error,
			};
			report.retried += 1;
		}

		this.queue.sort(byCreatedAt);
		this.persistAndPublish();
		return report;
	}

	async dropWhere(
		predicate: (m: QueuedMutation) => boolean,
		_reason: DropReason,
	): Promise<number> {
		const before = this.queue.length;
		this.queue = this.queue.filter((mutation) => !predicate(mutation));
		const dropped = before - this.queue.length;
		if (dropped > 0) {
			this.persistAndPublish();
		}
		return dropped;
	}

	pending$(): ObservableLike<QueuedMutation[]> {
		return {
			subscribe: (next) => {
				this.subscribers.add(next);
				next(cloneMutations(this.queue));
				return {
					unsubscribe: () => {
						this.subscribers.delete(next);
					},
				};
			},
		};
	}

	getPending(accountId: string): QueuedMutation[] {
		const normalizedAccountId = accountId.replace(/\s/g, "");
		return cloneMutations(
			this.queue.filter(
				(mutation) =>
					mutation.entityId.replace(/\s/g, "") === normalizedAccountId,
			),
		);
	}

	getNextRetryAt(accountId: string): number | null {
		const pending = this.getPending(accountId);
		if (pending.length === 0) return null;
		return Math.min(...pending.map((mutation) => mutation.nextRetryAt));
	}

	private persistAndPublish() {
		this.storage.write(this.queue);
		const snapshot = cloneMutations(this.queue);
		for (const subscriber of this.subscribers) {
			subscriber(snapshot);
		}
	}
}

export function createLocalStorageMutationQueueStorage(
	storageKey: string,
): MutationQueueStorage {
	let writeBlocked = false;
	return {
		read() {
			const result = readVersionedLocalStorageArray({
				storageKey,
				collection: "mutationOutbox",
				parse: parseQueuedMutation,
			});
			writeBlocked ||= result.writeBlocked;
			return result.records;
		},
		write(mutations) {
			if (typeof window === "undefined" || writeBlocked) return;
			try {
				window.localStorage.setItem(
					storageKey,
					JSON.stringify(mutations.map((mutation) => ({ ...mutation, schemaVersion: 1 }))),
				);
			} catch {
				return;
			}
		},
	};
}

export function createMemoryMutationQueueStorage(
	initial: QueuedMutation[] = [],
): MutationQueueStorage {
	let queue = cloneMutations(initial);

	return {
		read() {
			return cloneMutations(queue);
		},
		write(mutations) {
			queue = cloneMutations(mutations);
		},
	};
}

export function createLocalFirstMutationQueueStorage(
	db: LocalFirstDatabase,
): MutationQueueStorage {
	const collection = db.collections.mutationOutbox;

	return {
		read() {
			return Array.from(collection.values())
				.map((doc) => parseQueuedMutation(doc))
				.filter((mutation): mutation is QueuedMutation => mutation !== null)
				.sort(byCreatedAt);
		},
		write(mutations) {
			replaceLocalFirstCollection(
				collection,
				mutations.map((mutation) => [
					mutation.queueId,
					{
						schemaVersion: 1,
						id: mutation.queueId,
					queueId: mutation.queueId,
					idempotencyKey: mutation.idempotencyKey,
					opType: mutation.opType,
					entityId: mutation.entityId,
					payload: mutation.payload,
					createdAt: mutation.createdAt,
					attemptCount: mutation.attemptCount,
					nextRetryAt: mutation.nextRetryAt,
					ackedAt: null,
					lastError: mutation.lastError ?? null,
					terminalReason: null,
					lastAttemptAt: null,
					insertedAt: mutation.createdAt,
					},
				] as const),
			);
		},
	};
}
