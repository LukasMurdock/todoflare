import { assign, fromPromise, setup } from "xstate";
import {
	columnSocketActor,
	type ColumnSocketFrame,
	type ColumnSocketInput,
	type ColumnSocketLike,
} from "./column-socket-actor";
import type { ConnectionStatus, PresenceUser, SyncMessage } from "../../types/account";
import type { YjsOutboxKind } from "./yjs-update-outbox";

export type ColumnTerminationReason = "revoked" | "column_deleted";

export class ColumnSocketAuthorizationError extends Error {
	constructor(
		readonly status: number,
		readonly reason: ColumnTerminationReason | "reauth_required" =
			status === 401 ? "reauth_required" : status === 404 ? "column_deleted" : "revoked",
	) {
		super(`WebSocket authorization failed: ${status}`);
		this.name = "ColumnSocketAuthorizationError";
	}
}

export class ColumnSocketProvisioningError extends Error {
	constructor(readonly status: number) {
		super(`Column is still being provisioned: ${status}`);
		this.name = "ColumnSocketProvisioningError";
	}
}

export interface ColumnSessionContext {
	accountId: string;
	columnId: string;
	leases: ReadonlySet<string>;
	retryAttempt: number;
	hasConnected: boolean;
	presence: PresenceUser[];
	pendingAwareness: Uint8Array | null;
	lastClose: {
		code: number;
		reason: string;
		wasClean: boolean;
	} | null;
	terminationReason: ColumnTerminationReason | null;
	socketUrl: string | null;
	networkOnline: boolean;
	realtimeEnabled: boolean;
}

export interface ColumnSessionInput {
	accountId: string;
	columnId: string;
	networkOnline: boolean;
	realtimeEnabled: boolean;
}

export type ColumnSessionEvent =
	| { type: "SUBSCRIBE"; leaseId: string }
	| { type: "UNSUBSCRIBE"; leaseId: string }
	| { type: "SEND_SYNC"; update: Uint8Array }
	| { type: "SEND_AWARENESS"; update: Uint8Array }
	| { type: "NETWORK_OFFLINE" }
	| { type: "NETWORK_ONLINE" }
	| { type: "REALTIME_DISABLED" }
	| { type: "REALTIME_ENABLED" }
	| { type: "SOCKET_OPENED" }
	| {
			type: "SOCKET_CLOSED";
			code: number;
			reason: string;
			wasClean: boolean;
	  }
	| { type: "SOCKET_MESSAGE"; message: SyncMessage }
	| { type: "OUTBOX_ACKNOWLEDGED"; outboxId: string }
	| { type: "OUTBOX_REPLAYED" }
	| { type: "ACCESS_REVOKED" }
	| { type: "COLUMN_DELETED" };

export interface ColumnSessionDependencies {
	onAuthenticationRequired?: () => void;
	createSocket: (url: string, protocols: string[]) => ColumnSocketLike;
	getSocketUrl: (
		accountId: string,
		columnId: string,
		signal: AbortSignal,
	) => Promise<string>;
	persistUpdate: (
		accountId: string,
		columnId: string,
		kind: YjsOutboxKind,
		update: Uint8Array,
	) => string;
	loadReplayFrames: (
		accountId: string,
		columnId: string,
	) => ColumnSocketFrame[];
	onBestEffortFrameWritten: (frame: ColumnSocketFrame) => void;
	onDurableFrameAcknowledged: (
		accountId: string,
		columnId: string,
		outboxId: string,
	) => void;
	onMessage: (columnId: string, message: SyncMessage) => void;
	onTerminate: (
		columnId: string,
		reason: ColumnTerminationReason,
	) => Promise<void>;
	encodeUpdate: (
		kind: YjsOutboxKind,
		update: Uint8Array,
		outboxId: string,
	) => ArrayBuffer;
}

function withLease(leases: ReadonlySet<string>, leaseId: string) {
	const next = new Set(leases);
	next.add(leaseId);
	return next;
}

function withoutLease(leases: ReadonlySet<string>, leaseId: string) {
	if (!leases.has(leaseId)) return leases;
	const next = new Set(leases);
	next.delete(leaseId);
	return next;
}

export function createColumnSessionMachine(dependencies: ColumnSessionDependencies) {
	const socketInput = ({ context }: { context: ColumnSessionContext }): ColumnSocketInput => ({
		url: context.socketUrl ?? "",
		createSocket: dependencies.createSocket,
		loadReplayFrames: () =>
			dependencies.loadReplayFrames(context.accountId, context.columnId),
		onBestEffortFrameWritten: dependencies.onBestEffortFrameWritten,
	});

	const persistAndMaybeSend = (
		context: ColumnSessionContext,
		kind: YjsOutboxKind,
		update: Uint8Array,
		send: ((frame: ColumnSocketFrame) => void) | null,
	) => {
		const outboxId = dependencies.persistUpdate(
			context.accountId,
			context.columnId,
			kind,
			update,
		);
		if (send) {
			send({
				data: dependencies.encodeUpdate(kind, update, outboxId),
				outboxId,
				requiresAck: kind === "sync",
			});
		}
	};

	return setup({
		types: {} as {
			context: ColumnSessionContext;
			input: ColumnSessionInput;
			events: ColumnSessionEvent;
		},
		actors: {
			authorizeSocket: fromPromise<
				string,
				{ accountId: string; columnId: string }
			>(({ input, signal }) =>
				dependencies.getSocketUrl(input.accountId, input.columnId, signal),
			),
			columnSocket: columnSocketActor,
			terminalCleanup: fromPromise<
				void,
				{ columnId: string; reason: ColumnTerminationReason }
			>(async ({ input }) => {
				await dependencies.onTerminate(input.columnId, input.reason);
			}),
		},
		delays: {
			retryDelay: ({ context }) =>
				Math.min(1_000 * 2 ** Math.max(0, context.retryAttempt - 1), 30_000),
		},
		guards: {
			isLastLease: ({ context, event }) =>
				event.type === "UNSUBSCRIBE" &&
				context.leases.has(event.leaseId) &&
				context.leases.size === 1,
			canConnect: ({ context }) =>
				context.networkOnline &&
				context.realtimeEnabled &&
				context.leases.size > 0,
			canConnectAfterSubscribe: ({ context }) =>
				context.networkOnline && context.realtimeEnabled,
			canConnectAfterOnline: ({ context }) =>
				context.realtimeEnabled && context.leases.size > 0,
			canConnectAfterEnabled: ({ context }) =>
				context.networkOnline && context.leases.size > 0,
		},
		actions: {
			addLease: assign({
				leases: ({ context, event }) =>
					event.type === "SUBSCRIBE"
						? withLease(context.leases, event.leaseId)
						: context.leases,
			}),
			removeLease: assign({
				leases: ({ context, event }) =>
					event.type === "UNSUBSCRIBE"
						? withoutLease(context.leases, event.leaseId)
						: context.leases,
			}),
			setNetworkOffline: assign({ networkOnline: false }),
			setNetworkOnline: assign({ networkOnline: true }),
			setRealtimeDisabled: assign({ realtimeEnabled: false }),
			setRealtimeEnabled: assign({ realtimeEnabled: true }),
			recordClose: assign({
				lastClose: ({ event }) =>
					event.type === "SOCKET_CLOSED"
						? {
								code: event.code,
								reason: event.reason,
								wasClean: event.wasClean,
							}
						: null,
				retryAttempt: ({ context }) => context.retryAttempt + 1,
			}),
			recordSocketUrl: assign((_, params: { url: string }) => ({
				socketUrl: params.url,
			})),
			notifyAuthenticationRequired: () => dependencies.onAuthenticationRequired?.(),
			recordAuthorizationFailure: assign({
				socketUrl: null,
				retryAttempt: ({ context }) => context.retryAttempt + 1,
			}),
			markConnected: assign({
				hasConnected: true,
				retryAttempt: 0,
				pendingAwareness: null,
			}),
			recordPresence: assign({
				presence: ({ context, event }) =>
					event.type === "SOCKET_MESSAGE" && event.message.type === "presence"
						? event.message.users
						: context.presence,
			}),
			acknowledgeOutbox: ({ context, event }) => {
				if (event.type === "OUTBOX_ACKNOWLEDGED") {
					dependencies.onDurableFrameAcknowledged(
						context.accountId,
						context.columnId,
						event.outboxId,
					);
				}
			},
			forwardMessage: ({ context, event }) => {
				if (event.type === "SOCKET_MESSAGE") {
					dependencies.onMessage(context.columnId, event.message);
				}
			},
			persistSync: ({ context, event }) => {
				if (event.type === "SEND_SYNC") {
					persistAndMaybeSend(context, "sync", event.update, null);
				}
			},
			persistAwareness: ({ context, event }) => {
				if (event.type === "SEND_AWARENESS") {
					persistAndMaybeSend(context, "awareness", event.update, null);
				}
			},
			sendLiveSync: ({ context, event, self }) => {
				if (event.type !== "SEND_SYNC") return;
				const socket = self.getSnapshot().children.columnSocket;
				persistAndMaybeSend(
					context,
					"sync",
					event.update,
					socket ? (frame) => socket.send({ type: "SEND_FRAME", frame }) : null,
				);
			},
			sendLiveAwareness: ({ context, event, self }) => {
				if (event.type !== "SEND_AWARENESS") return;
				const socket = self.getSnapshot().children.columnSocket;
				persistAndMaybeSend(
					context,
					"awareness",
					event.update,
					socket ? (frame) => socket.send({ type: "SEND_FRAME", frame }) : null,
				);
			},
			rememberAwareness: assign({
				pendingAwareness: ({ event }) =>
					event.type === "SEND_AWARENESS" ? event.update : null,
			}),
			setRevoked: assign({ terminationReason: "revoked" as const }),
			setDeleted: assign({ terminationReason: "column_deleted" as const }),
		},
	}).createMachine({
		id: "columnSession",
		context: ({ input }) => ({
			accountId: input.accountId,
			columnId: input.columnId,
			leases: new Set<string>(),
			retryAttempt: 0,
			hasConnected: false,
			presence: [],
			pendingAwareness: null,
			lastClose: null,
			terminationReason: null,
			socketUrl: null,
			networkOnline: input.networkOnline,
			realtimeEnabled: input.realtimeEnabled,
		}),
		initial: "inactive",
		on: {
			ACCESS_REVOKED: { target: ".terminating", actions: "setRevoked" },
			COLUMN_DELETED: { target: ".terminating", actions: "setDeleted" },
		},
		states: {
			inactive: {
				on: {
					SUBSCRIBE: [
						{
							guard: "canConnectAfterSubscribe",
							target: "active",
							actions: "addLease",
						},
						{ target: "paused", actions: "addLease" },
					],
					UNSUBSCRIBE: { actions: "removeLease" },
					SEND_SYNC: { actions: "persistSync" },
					SEND_AWARENESS: {
						actions: ["persistAwareness", "rememberAwareness"],
					},
					NETWORK_OFFLINE: { actions: "setNetworkOffline" },
					NETWORK_ONLINE: { actions: "setNetworkOnline" },
					REALTIME_DISABLED: { actions: "setRealtimeDisabled" },
					REALTIME_ENABLED: { actions: "setRealtimeEnabled" },
				},
			},
			active: {
				initial: "authorizing",
				on: {
					OUTBOX_ACKNOWLEDGED: { actions: "acknowledgeOutbox" },
					SUBSCRIBE: { actions: "addLease" },
					UNSUBSCRIBE: [
						{ guard: "isLastLease", target: "inactive", actions: "removeLease" },
						{ actions: "removeLease" },
					],
					NETWORK_OFFLINE: {
						target: "paused",
						actions: "setNetworkOffline",
					},
					REALTIME_DISABLED: {
						target: "paused",
						actions: "setRealtimeDisabled",
					},
					SEND_SYNC: { actions: "persistSync" },
					SEND_AWARENESS: {
						actions: ["persistAwareness", "rememberAwareness"],
					},
					SOCKET_CLOSED: {
						target: "reconnectDelay",
						actions: "recordClose",
					},
				},
				states: {
					authorizing: {
						invoke: {
							id: "authorizeSocket",
							src: "authorizeSocket",
							input: ({ context }) => ({
								accountId: context.accountId,
								columnId: context.columnId,
							}),
							onDone: {
								target: "transport",
								actions: {
									type: "recordSocketUrl",
									params: ({ event }) => ({ url: event.output }),
								},
							},
							onError: [
								{
									guard: ({ event }) => event.error instanceof ColumnSocketAuthorizationError && event.error.reason === "reauth_required",
									target: "#columnSession.paused",
									actions: ["setRealtimeDisabled", "notifyAuthenticationRequired"],
								},
								{
									guard: ({ event }) =>
										event.error instanceof ColumnSocketAuthorizationError &&
										event.error.reason === "column_deleted",
									target: "#columnSession.terminating",
									actions: "setDeleted",
								},
								{
									guard: ({ event }) =>
										event.error instanceof ColumnSocketAuthorizationError &&
										event.error.reason === "revoked",
									target: "#columnSession.terminating",
									actions: "setRevoked",
								},
								{
									target: "#columnSession.reconnectDelay",
									actions: "recordAuthorizationFailure",
								},
							],
						},
					},
					transport: {
						invoke: {
							id: "columnSocket",
							src: "columnSocket",
							input: socketInput,
						},
						initial: "connecting",
						states: {
							connecting: {
								on: { SOCKET_OPENED: "replaying" },
							},
							replaying: {
								on: {
									OUTBOX_REPLAYED: {
										target: "connected",
										actions: "markConnected",
									},
								},
							},
							connected: {
								on: {
									SOCKET_MESSAGE: {
										actions: ["recordPresence", "forwardMessage"],
									},
									SEND_SYNC: { actions: "sendLiveSync" },
									SEND_AWARENESS: { actions: "sendLiveAwareness" },
								},
							},
						},
					},
				},
			},
			reconnectDelay: {
				after: { retryDelay: { target: "active", guard: "canConnect" } },
				on: {
					SUBSCRIBE: { actions: "addLease" },
					UNSUBSCRIBE: [
						{ guard: "isLastLease", target: "inactive", actions: "removeLease" },
						{ actions: "removeLease" },
					],
					SEND_SYNC: { actions: "persistSync" },
					SEND_AWARENESS: { actions: ["persistAwareness", "rememberAwareness"] },
					NETWORK_OFFLINE: { target: "paused", actions: "setNetworkOffline" },
					REALTIME_DISABLED: { target: "paused", actions: "setRealtimeDisabled" },
				},
			},
			paused: {
				on: {
					SUBSCRIBE: { actions: "addLease" },
					UNSUBSCRIBE: [
						{ guard: "isLastLease", target: "inactive", actions: "removeLease" },
						{ actions: "removeLease" },
					],
					SEND_SYNC: { actions: "persistSync" },
					SEND_AWARENESS: { actions: ["persistAwareness", "rememberAwareness"] },
					NETWORK_OFFLINE: { actions: "setNetworkOffline" },
					REALTIME_DISABLED: { actions: "setRealtimeDisabled" },
					NETWORK_ONLINE: [
						{ guard: "canConnectAfterOnline", target: "active", actions: "setNetworkOnline" },
						{ actions: "setNetworkOnline" },
					],
					REALTIME_ENABLED: [
						{ guard: "canConnectAfterEnabled", target: "active", actions: "setRealtimeEnabled" },
						{ actions: "setRealtimeEnabled" },
					],
				},
			},
			terminating: {
				invoke: {
					src: "terminalCleanup",
					input: ({ context }) => ({
						columnId: context.columnId,
						reason: context.terminationReason ?? "revoked",
					}),
					onDone: "terminated",
					onError: "terminated",
				},
			},
			terminated: { type: "final" },
		},
	});
}

export function columnSessionConnectionStatus(snapshot: {
	matches(value: unknown): boolean;
}): ConnectionStatus {
	if (snapshot.matches({ active: { transport: "connected" } })) return "connected";
	if (
		snapshot.matches({ active: "authorizing" }) ||
		snapshot.matches({ active: { transport: "connecting" } }) ||
		snapshot.matches({ active: { transport: "replaying" } })
	) {
		return "connecting";
	}
	return "offline";
}
