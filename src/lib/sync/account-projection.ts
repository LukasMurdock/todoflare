import type {
	Account,
	ColumnMeta,
	DeletedColumn,
	GetAccountResponse,
	PublicLinkResponse,
} from "../../types/account";

export interface LocalAccountProjectionSource {
	account: Account;
	sharedColumns?: ColumnMeta[];
	deletedColumns?: DeletedColumn[];
	sharedWithByColumn?: Record<string, string[] | undefined>;
	publicLinksByColumn?: Record<string, PublicLinkResponse | null>;
}
import type {
	AccountCommandEffect,
	QueuedMutation,
	ReplayCommandSummary,
} from "./contracts";

export interface AccountProjection {
	account: Account;
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	sharedWithByColumn: Record<string, string[] | undefined>;
	publicLinksByColumn: Record<string, PublicLinkResponse | null>;
}

export function projectionFromServer(
	response: GetAccountResponse,
	publicOrigin = "",
): AccountProjection {
	return {
		account: response.account,
		sharedColumns: response.sharedColumns,
		deletedColumns: response.deletedColumns,
		sharedWithByColumn: Object.fromEntries(
			response.ownedColumns.map((column) => [
				column.id,
				[...column.sharedWith],
			]),
		),
		publicLinksByColumn: Object.fromEntries(
			response.ownedColumns.map((column) => [
				column.id,
				column.publicId
					? {
							publicId: column.publicId,
							url: `${publicOrigin}/p/${column.publicId}`,
						}
					: null,
			]),
		),
	};
}

/** Build an offline projection from retained local metadata, never network data. */
export function projectionFromLocalSnapshot(
	source: LocalAccountProjectionSource,
): AccountProjection {
	return {
		account: source.account,
		sharedColumns: source.sharedColumns ?? [],
		deletedColumns: source.deletedColumns ?? [],
		sharedWithByColumn: Object.fromEntries(
			Object.entries(source.sharedWithByColumn ?? {}).map(([columnId, ids]) => [
				columnId,
				ids ? [...ids] : undefined,
			]),
		),
		publicLinksByColumn: { ...(source.publicLinksByColumn ?? {}) },
	};
}

export function cloneAccountProjection(
	projection: AccountProjection,
): AccountProjection {
	return {
		account: {
			...projection.account,
			columnOrder: [...projection.account.columnOrder],
			hiddenSharedColumns: [...projection.account.hiddenSharedColumns],
		},
		sharedColumns: projection.sharedColumns.map((column) => ({
			...column,
			sharedWith: [...column.sharedWith],
		})),
		deletedColumns: projection.deletedColumns.map((column) => ({ ...column })),
		sharedWithByColumn: Object.fromEntries(
			Object.entries(projection.sharedWithByColumn).map(([columnId, ids]) => [
				columnId,
				ids ? [...ids] : undefined,
			]),
		),
		publicLinksByColumn: { ...projection.publicLinksByColumn },
	};
}

type ProjectableCommand = QueuedMutation | ReplayCommandSummary;

export function applyAccountCommand(
	projection: AccountProjection,
	command: ProjectableCommand,
): AccountProjection {
	const next = cloneAccountProjection(projection);

	switch (command.opType) {
		case "column.create": {
			const { columnId } = command.payload;
			if (!next.account.columnOrder.includes(columnId)) {
				next.account.columnOrder.push(columnId);
			}
			next.deletedColumns = next.deletedColumns.filter(
				(entry) => entry.columnId !== columnId,
			);
			return next;
		}
		case "column.delete": {
			const { columnId } = command.payload;
			next.account.columnOrder = next.account.columnOrder.filter(
				(id) => id !== columnId,
			);
			if (!next.deletedColumns.some((entry) => entry.columnId === columnId)) {
				next.deletedColumns.unshift({
					columnId,
					deletedAt: command.createdAt,
				});
			}
			return next;
		}
		case "column.restore": {
			const { columnId } = command.payload;
			next.deletedColumns = next.deletedColumns.filter(
				(entry) => entry.columnId !== columnId,
			);
			if (!next.account.columnOrder.includes(columnId)) {
				next.account.columnOrder.push(columnId);
			}
			return next;
		}
		case "column.reorder":
			next.account.columnOrder = [...command.payload.columnOrder];
			return next;
		case "column.hide_shared":
			next.account.hiddenSharedColumns = [
				...command.payload.hiddenSharedColumns,
			];
			return next;
		case "column.share": {
			const { columnId, targetAccountId } = command.payload;
			const sharedWith = next.sharedWithByColumn[columnId] ?? [];
			if (!sharedWith.includes(targetAccountId)) {
				next.sharedWithByColumn[columnId] = [...sharedWith, targetAccountId];
			}
			return next;
		}
		case "column.revoke": {
			const { columnId, targetAccountId } = command.payload;
			next.sharedWithByColumn[columnId] = (
				next.sharedWithByColumn[columnId] ?? []
			).filter((id) => id !== targetAccountId);
			return next;
		}
		case "column.public.enable":
			return next;
		case "column.public.disable":
			next.publicLinksByColumn[command.payload.columnId] = null;
			return next;
	}
}

export function applyPendingCommands(
	serverBase: AccountProjection,
	commands: readonly QueuedMutation[],
): AccountProjection {
	return commands.reduce(applyAccountCommand, cloneAccountProjection(serverBase));
}

export function applyCommandEffects(
	projection: AccountProjection,
	effects: readonly AccountCommandEffect[],
): AccountProjection {
	const next = cloneAccountProjection(projection);

	for (const effect of effects) {
		switch (effect.type) {
			case "column.created":
				if (!next.account.columnOrder.includes(effect.column.id)) {
					next.account.columnOrder.push(effect.column.id);
				}
				break;
			case "column.deleted":
				delete next.sharedWithByColumn[effect.columnId];
				delete next.publicLinksByColumn[effect.columnId];
				break;
			case "column.sharing.updated":
				next.sharedWithByColumn[effect.columnId] = [...effect.sharedWith];
				break;
			case "column.public.enabled":
				next.publicLinksByColumn[effect.columnId] = effect.publicLink;
				break;
			case "column.public.disabled":
				next.publicLinksByColumn[effect.columnId] = null;
				break;
		}
	}

	return next;
}

export function removeColumnFromProjection(
	projection: AccountProjection,
	columnId: string,
): AccountProjection {
	const next = cloneAccountProjection(projection);
	next.account.columnOrder = next.account.columnOrder.filter(
		(id) => id !== columnId,
	);
	next.account.hiddenSharedColumns = next.account.hiddenSharedColumns.filter(
		(id) => id !== columnId,
	);
	next.sharedColumns = next.sharedColumns.filter((column) => column.id !== columnId);
	delete next.sharedWithByColumn[columnId];
	delete next.publicLinksByColumn[columnId];
	return next;
}
