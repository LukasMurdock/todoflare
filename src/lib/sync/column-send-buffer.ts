export type BufferedColumnSend =
	| { kind: "sync"; payload: Uint8Array }
	| { kind: "awareness"; payload: Uint8Array };

export interface BufferedColumnConnection<
	TMessage extends BufferedColumnSend = BufferedColumnSend,
> {
	ws: { readyState: number; send(data: ArrayBuffer): void } | null;
	pendingSends: TMessage[];
}

export interface FlushableColumnConnection<
	TMessage extends BufferedColumnSend = BufferedColumnSend,
> extends BufferedColumnConnection<TMessage> {
	status: string;
}

export type PendingDropPolicy = "drop_oldest" | "drop_awareness_first";

export interface PendingDropEvent<
	TMessage extends BufferedColumnSend = BufferedColumnSend,
> {
	droppedMessage: TMessage;
	pendingCount: number;
	reason: "cap_exceeded";
}

export interface QueueOrSendOptions<
	TMessage extends BufferedColumnSend = BufferedColumnSend,
> {
	maxPendingMessages?: number;
	dropPolicy?: PendingDropPolicy;
	onSent?: (message: TMessage) => void;
	onDrop?: (event: PendingDropEvent<TMessage>) => void;
}

export interface FlushBufferedMessagesOptions<
	TMessage extends BufferedColumnSend = BufferedColumnSend,
> {
	onSent?: (message: TMessage) => void;
}

const WS_READY_STATE_OPEN = 1;

export function queueOrSendColumnMessage<
	TMessage extends BufferedColumnSend,
>(
	connection: BufferedColumnConnection<TMessage>,
	message: TMessage,
	encodeMessage: (message: TMessage) => ArrayBuffer,
	options?: QueueOrSendOptions<TMessage>,
) {
	if (connection.ws && connection.ws.readyState === WS_READY_STATE_OPEN) {
		try {
			connection.ws.send(encodeMessage(message));
			options?.onSent?.(message);
			return;
		} catch {
			// Fall back to queueing below.
		}
	}

	connection.pendingSends.push(message);

	const maxPending = options?.maxPendingMessages;
	if (typeof maxPending !== "number" || !Number.isFinite(maxPending)) return;

	const normalizedLimit = Math.max(0, Math.floor(maxPending));
	const dropPolicy = options?.dropPolicy ?? "drop_oldest";

	while (connection.pendingSends.length > normalizedLimit) {
		let dropIndex = 0;
		if (dropPolicy === "drop_awareness_first") {
			dropIndex = connection.pendingSends.findIndex(
				(queuedMessage) => queuedMessage.kind === "awareness",
			);
			if (dropIndex < 0) {
				dropIndex = 0;
			}
		}

		const [droppedMessage] = connection.pendingSends.splice(dropIndex, 1);
		if (!droppedMessage) break;

		options?.onDrop?.({
			droppedMessage,
			pendingCount: connection.pendingSends.length,
			reason: "cap_exceeded",
		});
	}
}

export function flushBufferedColumnMessages<
	TMessage extends BufferedColumnSend,
>(
	connection: FlushableColumnConnection<TMessage>,
	encodeMessage: (message: TMessage) => ArrayBuffer,
	options?: FlushBufferedMessagesOptions<TMessage>,
): number {
	if (connection.status !== "connected") return 0;
	if (!connection.ws || connection.ws.readyState !== WS_READY_STATE_OPEN) return 0;
	if (connection.pendingSends.length === 0) return 0;

	const ws = connection.ws;
	const remaining: TMessage[] = [];
	let sentCount = 0;

	for (const message of connection.pendingSends) {
		try {
			ws.send(encodeMessage(message));
			sentCount += 1;
			options?.onSent?.(message);
		} catch {
			remaining.push(message);
		}
	}

	connection.pendingSends = remaining;
	return sentCount;
}
