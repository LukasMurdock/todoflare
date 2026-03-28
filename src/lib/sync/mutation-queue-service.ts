import type {
	AccountEditCommand,
	DropReason,
	MutationQueueService,
	ObservableLike,
	QueuedMutation,
	ReplayReport,
	TerminalReplayReason,
} from "@/lib/sync/contracts";
import type { MutationOutboxDoc } from "@/lib/local-first/collections";
import type { LocalFirstDatabase } from "@/lib/local-first/rxdb";

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
) => Promise<MutationReplayResult>;

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

	async enqueue(cmd: AccountEditCommand): Promise<string> {
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
		const persistedMutations = storage.read().sort(byCreatedAt);
		this.storage = storage;
		this.queue = mergeMutationsByQueueId(persistedMutations, this.queue).sort(
			byCreatedAt,
		);
		this.persistAndPublish();
	}

	async replay(options?: { maxBatch?: number }): Promise<ReplayReport> {
		const now = Date.now();
		const maxBatch = options?.maxBatch ?? 50;
		const eligible = this.queue
			.filter((mutation) => mutation.nextRetryAt <= now)
			.sort(byCreatedAt)
			.slice(0, maxBatch);

		const report: ReplayReport = {
			attempted: 0,
			acked: 0,
			retried: 0,
			dropped: 0,
			ackedCommands: [],
			terminalFailures: [],
		};

		for (const mutation of eligible) {
			report.attempted += 1;

			let result: MutationReplayResult;
			try {
				result = await this.executeMutation(mutation);
			} catch (err) {
				result = { kind: "retry", error: toErrorMessage(err) };
			}

			const index = this.queue.findIndex((entry) => entry.queueId === mutation.queueId);
			if (index < 0) continue;

			if (result.kind === "ack") {
				this.queue.splice(index, 1);
				report.acked += 1;
				report.ackedCommands.push({
					queueId: mutation.queueId,
					opType: mutation.opType,
					entityId: mutation.entityId,
					payload: mutation.payload,
				});
				continue;
			}

			if (result.kind === "drop") {
				this.queue.splice(index, 1);
				report.dropped += 1;
				report.terminalFailures.push({
					queueId: mutation.queueId,
					reason: result.reason,
					opType: mutation.opType,
					entityId: mutation.entityId,
					payload: mutation.payload,
				});
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
	return {
		read() {
			if (typeof window === "undefined") return [];
			try {
				const raw = window.localStorage.getItem(storageKey);
				if (!raw) return [];
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				return parsed as QueuedMutation[];
			} catch {
				return [];
			}
		},
		write(mutations) {
			if (typeof window === "undefined") return;
			try {
				window.localStorage.setItem(storageKey, JSON.stringify(mutations));
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

function mutationFromOutboxDoc(doc: MutationOutboxDoc): QueuedMutation {
	return {
		queueId: doc.queueId,
		idempotencyKey: doc.idempotencyKey,
		opType: doc.opType,
		entityId: doc.entityId,
		payload: doc.payload,
		createdAt: doc.createdAt,
		attemptCount: doc.attemptCount,
		nextRetryAt: doc.nextRetryAt,
		lastError: doc.lastError ?? undefined,
	};
}

export function createLocalFirstMutationQueueStorage(
	db: LocalFirstDatabase,
): MutationQueueStorage {
	const collection = db.collections.mutationOutbox;

	return {
		read() {
			return Array.from(collection.values())
				.map((doc) => mutationFromOutboxDoc(doc))
				.sort(byCreatedAt);
		},
		write(mutations) {
			collection.clear();
			for (const mutation of mutations) {
				collection.set(mutation.queueId, {
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
				});
			}
		},
	};
}
