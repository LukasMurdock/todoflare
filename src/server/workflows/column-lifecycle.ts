import type { ColumnMeta } from "../../types/account";
import type { SchemaParseResult } from "../persistence-records";

export interface ColumnLifecycleBindings<TColumnRoomId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	COLUMN_ROOM: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	PUBLIC_ID_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
}

export type ColumnLifecycleWriteObserver<TBoundary extends string> = (
	boundary: TBoundary,
) => void | Promise<void>;

export type ColumnLifecycleFailure =
	| {
			kind: "api";
			code: "not_found";
			message: string;
			status: 404 | 410;
	  }
	| {
			kind: "schema";
			record: "account" | "column_meta" | "shared_index" | "trash";
			result: Extract<SchemaParseResult<unknown>, { ok: false }>;
	  }
	| {
			kind: "owner";
			meta: ColumnMeta;
			message: string;
	  };

export type ColumnLifecycleResult<T> =
	| { ok: true; value: T }
	| { ok: false; failure: ColumnLifecycleFailure };

export const lifecycleNotFound = (
	message: string,
	status: 404 | 410 = 404,
): ColumnLifecycleResult<never> => ({
	ok: false,
	failure: { kind: "api", code: "not_found", message, status },
});
