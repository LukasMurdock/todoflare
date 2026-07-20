import type { ConnectionStatus } from "@/types/account";

export type SyncMode =
	| "guest_local"
	| "account_offline"
	| "account_syncing"
	| "account_realtime"
	| "public_readonly";

export interface SyncModeContext {
	hasAccountSession: boolean;
	isPublicReadonly: boolean;
	isNetworkOnline: boolean;
	connectionStatus: ConnectionStatus;
}

export function deriveSyncMode(ctx: SyncModeContext): SyncMode {
	if (ctx.isPublicReadonly) {
		return "public_readonly";
	}

	if (!ctx.hasAccountSession) {
		return "guest_local";
	}

	if (!ctx.isNetworkOnline) {
		return "account_offline";
	}

	if (ctx.connectionStatus === "connected") {
		return "account_realtime";
	}

	return "account_syncing";
}
