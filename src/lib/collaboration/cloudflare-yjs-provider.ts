import type { ProviderConstructorProps, UnifiedProvider } from "@platejs/yjs";
import { registerProviderType } from "@platejs/yjs";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { Awareness } from "y-protocols/awareness";
import type { SyncMessage } from "@/types/account";

export type ColumnSyncTransport = {
	connectToColumn: (columnId: string) => void;
	disconnectFromColumn: (columnId: string) => void;
	onColumnMessage: (
		columnId: string,
		cb: (message: SyncMessage) => void,
	) => () => void;
	sendUpdate: (columnId: string, update: Uint8Array) => void;
	sendAwareness: (columnId: string, update: Uint8Array) => void;
};

export type CloudflareProviderOptions = {
	columnId: string;
	transport: ColumnSyncTransport;
};

class CloudflareProvider implements UnifiedProvider {
	type = "cloudflare";
	isConnected = false;
	isSynced = false;

	awareness: Awareness;
	document: Y.Doc;

	private readonly options: CloudflareProviderOptions;
	private readonly onConnect?: () => void;
	private readonly onDisconnect?: () => void;
	private readonly onError?: (error: Error) => void;
	private readonly onSyncChange?: (isSynced: boolean) => void;

	private unsubscribe?: () => void;
	private docUpdateHandler?: (update: Uint8Array, origin: unknown) => void;
	private awarenessUpdateHandler?: (
		update: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => void;

	constructor({
		options,
		awareness,
		doc,
		onConnect,
		onDisconnect,
		onError,
		onSyncChange,
	}: ProviderConstructorProps<CloudflareProviderOptions>) {
		this.options = options;
		const document = doc ?? new Y.Doc();
		this.document = document;
		this.awareness = awareness ?? new awarenessProtocol.Awareness(document);
		this.onConnect = onConnect;
		this.onDisconnect = onDisconnect;
		this.onError = onError;
		this.onSyncChange = onSyncChange;
	}

	connect() {
		if (this.isConnected) return;
		this.isConnected = true;


		try {
			this.options.transport.connectToColumn(this.options.columnId);
			this.onConnect?.();
		} catch (err) {
			this.onError?.(err instanceof Error ? err : new Error(String(err)));
		}

		this.unsubscribe = this.options.transport.onColumnMessage(
			this.options.columnId,
			(message) => {
				try {
					if (message.type === "sync") {
						Y.applyUpdate(this.document, message.data, "remote");

						if (!this.isSynced) {
							this.isSynced = true;
							this.onSyncChange?.(true);
						}
					}

					if (message.type === "awareness") {
						awarenessProtocol.applyAwarenessUpdate(
							this.awareness,
							message.data,
							"remote",
						);
					}
				} catch (err) {
					this.onError?.(
						err instanceof Error ? err : new Error("Provider error"),
					);
				}
			},
		);

		this.docUpdateHandler = (update: Uint8Array, origin: unknown) => {
			if (!this.isConnected) return;
			if (origin === "remote") return;
			this.options.transport.sendUpdate(this.options.columnId, update);
		};
		this.document.on("update", this.docUpdateHandler);

		this.awarenessUpdateHandler = (
			{ added, updated, removed },
			origin: unknown,
		) => {
			if (!this.isConnected) return;
			if (origin === "remote") return;

			const changedClients = [...added, ...updated, ...removed];
			if (changedClients.length === 0) return;

			const update = awarenessProtocol.encodeAwarenessUpdate(
				this.awareness,
				changedClients,
			);
			this.options.transport.sendAwareness(this.options.columnId, update);
		};
		this.awareness.on("update", this.awarenessUpdateHandler);
	}

	disconnect() {
		if (!this.isConnected) return;
		this.isConnected = false;

		if (this.isSynced) {
			this.isSynced = false;
			this.onSyncChange?.(false);
		}

		try {
			this.unsubscribe?.();
		} finally {
			this.unsubscribe = undefined;
		}

		if (this.docUpdateHandler) {
			this.document.off("update", this.docUpdateHandler);
			this.docUpdateHandler = undefined;
		}

		if (this.awarenessUpdateHandler) {
			this.awareness.off("update", this.awarenessUpdateHandler);
			this.awarenessUpdateHandler = undefined;
		}

		try {
			this.options.transport.disconnectFromColumn(this.options.columnId);
		} catch {
			// ignore
		}

		this.onDisconnect?.();
	}

	destroy() {
		this.disconnect();
	}
}

// Register once on module import.
registerProviderType("cloudflare", CloudflareProvider);

export type { CloudflareProvider };
