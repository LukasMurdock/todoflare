// Host 2: todoflare itself, rebuilt on the public API only.
// Everything account-, server- and storage-specific stays in the app; the
// board sees columns, a document adapter, and render props.
import * as React from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Value } from "platejs";
import { TodoBoard, type BoardColumn, type DocumentAdapter, type TodoBoardApi } from "../api";

// Existing app modules, declared here so the sketch type-checks on its own.
interface ColumnMetaLike { id: string; ownerId: string; publicId: string | null }
declare function useSyncContext(): {
	isHydrated: boolean;
	accountId: string | null;
	columnIds: string[];
	metaById: Map<string, ColumnMetaLike>;
	isOwner(columnId: string): boolean;
	writable: boolean;
	createColumn(): Promise<unknown>;
	deleteColumn(columnId: string): Promise<boolean>;
	hideSharedColumn(columnId: string): Promise<void>;
	updateColumnOrder(ownedIds: string[]): Promise<void>;
	loadColumnDocument(columnId: string): Promise<Uint8Array | null>;
	/** Today's Cloudflare transport (subscribe, messages, send update/awareness). */
	connectColumn(columnId: string, doc: Y.Doc, awareness: Awareness): () => void;
};
declare function ShareMenu(props: { columnId: string }): React.ReactNode;
declare function PresenceAvatars(props: { columnId: string }): React.ReactNode;
declare function ReconnectBanner(): React.ReactNode;
declare function StorageRecoveryBanner(): React.ReactNode;
declare function displayAccountId(id: string): string;
declare function getAccountColor(id: string): string;
declare function truncateAccountId(id: string): string;

/** The Cloudflare document adapter: IndexedDB cache first, then the column socket. */
function useCloudflareDocuments(): DocumentAdapter {
	const { loadColumnDocument, connectColumn } = useSyncContext();
	return React.useMemo<DocumentAdapter>(
		() => ({
			async open(columnId, signal) {
				const doc = new Y.Doc();
				const awareness = new Awareness(doc);
				const cached = await loadColumnDocument(columnId);
				signal.throwIfAborted();
				if (cached) Y.applyUpdate(doc, cached, "remote");
				const disconnect = connectColumn(columnId, doc, awareness);
				return {
					doc,
					awareness,
					release() {
						disconnect();
						awareness.destroy();
						doc.destroy();
					},
				};
			},
		}),
		[loadColumnDocument, connectColumn],
	);
}

export function TodoflareBoard({ boardRef }: { boardRef: React.Ref<TodoBoardApi> }) {
	const sync = useSyncContext();
	const documents = useCloudflareDocuments();
	const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

	const columns: BoardColumn[] = sync.columnIds.map((id) => {
		const owner = sync.metaById.get(id)?.ownerId;
		const owned = sync.isOwner(id);
		return {
			id,
			collapsed: collapsed[id] ?? false,
			readOnly: !sync.writable,
			removal: owned ? "delete" : "hide",
			label: !owned && owner ? `Shared by ${truncateAccountId(owner)}` : undefined,
		};
	});

	return (
		<TodoBoard
			ref={boardRef}
			// Fixes the measured placeholder-column flash: nothing renders until the account is known.
			status={sync.isHydrated ? "ready" : "loading"}
			columns={columns}
			documents={documents}
			identity={sync.accountId ? { name: displayAccountId(sync.accountId), color: getAccountColor(sync.accountId) } : undefined}
			onCreateColumn={() => sync.createColumn()}
			onRemoveColumn={(column) => (column.removal === "hide" ? sync.hideSharedColumn(column.id) : sync.deleteColumn(column.id))}
			onReorderColumns={(ids) => void sync.updateColumnOrder(ids.filter((id) => sync.isOwner(id)))}
			onCollapsedChange={(column, value) => setCollapsed((previous) => ({ ...previous, [column.id]: value }))}
			renderTopBar={() => (
				<>
					<StorageRecoveryBanner />
					<ReconnectBanner />
				</>
			)}
			renderColumnActions={(column) => (
				<>
					<PresenceAvatars columnId={column.id} />
					{sync.isOwner(column.id) && <ShareMenu columnId={column.id} />}
				</>
			)}
		/>
	);
}

// Guest mode keeps today's localStorage format by persisting Plate JSON.
export declare function useGuestDocuments(saveColumn: (columnId: string, content: Value) => void): DocumentAdapter;
