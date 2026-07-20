import { createActor, type ActorRefFrom } from "xstate";
import {
	columnSessionConnectionStatus,
	createColumnSessionMachine,
	type ColumnSessionDependencies,
	type ColumnSessionInput,
	type ColumnTerminationReason,
} from "./column-session-machine";
import type { ConnectionStatus, PresenceUser } from "../../types/account";

/**
 * The application entry point for authenticated per-column collaboration.
 *
 * UI and provider code should acquire a lease with subscribeToColumn() and use
 * the returned idempotent closure for cleanup. Socket and machine internals stay
 * behind this registry.
 */

type ColumnSessionActor = ActorRefFrom<ReturnType<typeof createColumnSessionMachine>>;

interface SessionRecord {
	actor: ColumnSessionActor;
	unsubscribeSnapshot: () => void;
}

export interface ColumnSessionManagerOptions {
	accountId: string;
	networkOnline: boolean;
	realtimeEnabled: boolean;
	dependencies: ColumnSessionDependencies;
	onStatusChange?: (status: ConnectionStatus) => void;
}

export class ColumnSessionManager {
	private readonly accountId: string;
	private readonly machine: ReturnType<typeof createColumnSessionMachine>;
	private readonly sessions = new Map<string, SessionRecord>();
	private networkOnline: boolean;
	private realtimeEnabled: boolean;
	private readonly onStatusChange?: (status: ConnectionStatus) => void;

	constructor(options: ColumnSessionManagerOptions) {
		this.accountId = options.accountId;
		this.networkOnline = options.networkOnline;
		this.realtimeEnabled = options.realtimeEnabled;
		this.machine = createColumnSessionMachine(options.dependencies);
		this.onStatusChange = options.onStatusChange;
	}

	subscribeToColumn(columnId: string) {
		const leaseId = crypto.randomUUID();
		const actor = this.ensureSession(columnId);
		actor.send({ type: "SUBSCRIBE", leaseId });
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			actor.send({ type: "UNSUBSCRIBE", leaseId });
		};
	}

	sendSync(columnId: string, update: Uint8Array) {
		this.ensureSession(columnId).send({ type: "SEND_SYNC", update });
	}

	sendAwareness(columnId: string, update: Uint8Array) {
		this.ensureSession(columnId).send({ type: "SEND_AWARENESS", update });
	}

	terminateColumn(columnId: string, reason: ColumnTerminationReason) {
		this.ensureSession(columnId).send({
			type: reason === "revoked" ? "ACCESS_REVOKED" : "COLUMN_DELETED",
		});
	}

	detachColumn(columnId: string) {
		const record = this.sessions.get(columnId);
		if (!record) return;
		record.unsubscribeSnapshot();
		record.actor.stop();
		this.sessions.delete(columnId);
		this.notifyStatus();
	}

	setNetworkOnline(online: boolean) {
		if (this.networkOnline === online) return;
		this.networkOnline = online;
		for (const { actor } of this.sessions.values()) {
			actor.send({ type: online ? "NETWORK_ONLINE" : "NETWORK_OFFLINE" });
		}
	}

	setRealtimeEnabled(enabled: boolean) {
		if (this.realtimeEnabled === enabled) return;
		this.realtimeEnabled = enabled;
		for (const { actor } of this.sessions.values()) {
			actor.send({
				type: enabled ? "REALTIME_ENABLED" : "REALTIME_DISABLED",
			});
		}
	}

	getColumnStatus(columnId: string): ConnectionStatus {
		const actor = this.sessions.get(columnId)?.actor;
		return actor ? columnSessionConnectionStatus(actor.getSnapshot()) : "offline";
	}

	getColumnPresence(columnId: string): PresenceUser[] {
		return this.sessions.get(columnId)?.actor.getSnapshot().context.presence ?? [];
	}

	getOverallStatus(): ConnectionStatus {
		let connecting = false;
		for (const { actor } of this.sessions.values()) {
			const snapshot = actor.getSnapshot();
			if (snapshot.context.leases.size === 0) continue;
			const status = columnSessionConnectionStatus(snapshot);
			if (status === "connected") return "connected";
			if (status === "connecting") connecting = true;
		}
		return connecting ? "connecting" : "offline";
	}

	stop() {
		for (const [columnId] of this.sessions) {
			this.detachColumn(columnId);
		}
		this.notifyStatus();
	}

	private ensureSession(columnId: string): ColumnSessionActor {
		const existing = this.sessions.get(columnId);
		if (existing) return existing.actor;

		const input: ColumnSessionInput = {
			accountId: this.accountId,
			columnId,
			networkOnline: this.networkOnline,
			realtimeEnabled: this.realtimeEnabled,
		};
		const actor = createActor(this.machine, { input });
		const subscription = actor.subscribe(() => this.notifyStatus());
		this.sessions.set(columnId, {
			actor,
			unsubscribeSnapshot: () => subscription.unsubscribe(),
		});
		actor.start();
		return actor;
	}

	private notifyStatus() {
		this.onStatusChange?.(this.getOverallStatus());
	}
}
