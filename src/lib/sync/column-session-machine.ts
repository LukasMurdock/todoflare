import { createAsyncLogic, setup, types, type ActorRefFrom } from "xstate";
import {
	columnSocketActor,
	type ColumnSocketFrame,
	type ColumnSocketInput,
	type ColumnSocketLike,
} from "./column-socket-actor";
import type {
	ConnectionStatus,
	PresenceUser,
	SyncMessage,
} from "../../types/account";
import type { YjsOutboxKind } from "./yjs-update-outbox";

export type ColumnTerminationReason = "revoked" | "column_deleted";

export class ColumnSocketAuthorizationError extends Error {
	constructor(
		readonly status: number,
		readonly reason:
			ColumnTerminationReason | "reauth_required" = status === 401
			? "reauth_required"
			: status === 404
				? "column_deleted"
				: "revoked"
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
		signal: AbortSignal
	) => Promise<string>;
	persistUpdate: (
		accountId: string,
		columnId: string,
		kind: YjsOutboxKind,
		update: Uint8Array
	) => string;
	loadReplayFrames: (
		accountId: string,
		columnId: string
	) => ColumnSocketFrame[];
	onBestEffortFrameWritten: (frame: ColumnSocketFrame) => void;
	onDurableFrameAcknowledged: (
		accountId: string,
		columnId: string,
		outboxId: string
	) => void;
	onMessage: (columnId: string, message: SyncMessage) => void;
	onTerminate: (
		columnId: string,
		reason: ColumnTerminationReason
	) => Promise<void>;
	encodeUpdate: (
		kind: YjsOutboxKind,
		update: Uint8Array,
		outboxId: string
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

export function createColumnSessionMachine(
	dependencies: ColumnSessionDependencies
) {
	const socketInput = ({
		context,
	}: {
		context: ColumnSessionContext;
	}): ColumnSocketInput => ({
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
		send: ((frame: ColumnSocketFrame) => void) | null
	) => {
		const outboxId = dependencies.persistUpdate(
			context.accountId,
			context.columnId,
			kind,
			update
		);
		if (send) {
			send({
				data: dependencies.encodeUpdate(kind, update, outboxId),
				outboxId,
				requiresAck: kind === "sync",
			});
		}
	};

	const actions = {
		addLease: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => ({
			leases:
				event.type === "SUBSCRIBE"
					? withLease(context.leases, event.leaseId)
					: context.leases,
		}),
		removeLease: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => ({
			leases:
				event.type === "UNSUBSCRIBE"
					? withoutLease(context.leases, event.leaseId)
					: context.leases,
		}),
		setNetworkOffline: () => ({ networkOnline: false }),
		setNetworkOnline: () => ({ networkOnline: true }),
		setRealtimeDisabled: () => ({ realtimeEnabled: false }),
		setRealtimeEnabled: () => ({ realtimeEnabled: true }),
		recordClose: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => ({
			lastClose:
				event.type === "SOCKET_CLOSED"
					? {
							code: event.code,
							reason: event.reason,
							wasClean: event.wasClean,
						}
					: null,
			retryAttempt: context.retryAttempt + 1,
		}),
		recordSocketUrl: (url: string) => ({
			socketUrl: url,
		}),
		notifyAuthenticationRequired: () =>
			dependencies.onAuthenticationRequired?.(),
		recordAuthorizationFailure: ({
			context,
		}: {
			context: ColumnSessionContext;
		}) => ({ socketUrl: null, retryAttempt: context.retryAttempt + 1 }),
		markConnected: () => ({
			hasConnected: true,
			retryAttempt: 0,
			pendingAwareness: null,
		}),
		recordPresence: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => ({
			presence:
				event.type === "SOCKET_MESSAGE" &&
				event.message.type === "presence"
					? event.message.users
					: context.presence,
		}),
		acknowledgeOutbox: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => {
			if (event.type === "OUTBOX_ACKNOWLEDGED") {
				dependencies.onDurableFrameAcknowledged(
					context.accountId,
					context.columnId,
					event.outboxId
				);
			}
		},
		forwardMessage: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => {
			if (event.type === "SOCKET_MESSAGE") {
				dependencies.onMessage(context.columnId, event.message);
			}
		},
		persistSync: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => {
			if (event.type === "SEND_SYNC") {
				persistAndMaybeSend(context, "sync", event.update, null);
			}
		},
		persistAwareness: ({
			context,
			event,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
		}) => {
			if (event.type === "SEND_AWARENESS") {
				persistAndMaybeSend(context, "awareness", event.update, null);
			}
		},
		sendLiveSync: ({
			context,
			event,
			children,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
			children: { columnSocket?: ActorRefFrom<typeof columnSocketActor> };
		}) => {
			if (event.type !== "SEND_SYNC") return;
			const socket = children.columnSocket;
			persistAndMaybeSend(
				context,
				"sync",
				event.update,
				socket
					? (frame) => socket.send({ type: "SEND_FRAME", frame })
					: null
			);
		},
		sendLiveAwareness: ({
			context,
			event,
			children,
		}: {
			context: ColumnSessionContext;
			event: ColumnSessionEvent;
			children: { columnSocket?: ActorRefFrom<typeof columnSocketActor> };
		}) => {
			if (event.type !== "SEND_AWARENESS") return;
			const socket = children.columnSocket;
			persistAndMaybeSend(
				context,
				"awareness",
				event.update,
				socket
					? (frame) => socket.send({ type: "SEND_FRAME", frame })
					: null
			);
		},
		rememberAwareness: ({ event }: { event: ColumnSessionEvent }) => ({
			pendingAwareness:
				event.type === "SEND_AWARENESS" ? event.update : null,
		}),
		setRevoked: () => ({ terminationReason: "revoked" as const }),
		setDeleted: () => ({ terminationReason: "column_deleted" as const }),
	};

	return setup({
		schemas: {
			context: types<ColumnSessionContext>(),
			input: types<ColumnSessionInput>(),
			events: {
				SUBSCRIBE: types<{ leaseId: string }>(),
				UNSUBSCRIBE: types<{ leaseId: string }>(),
				SEND_SYNC: types<{ update: Uint8Array }>(),
				SEND_AWARENESS: types<{ update: Uint8Array }>(),
				NETWORK_OFFLINE: types<void>(),
				NETWORK_ONLINE: types<void>(),
				REALTIME_DISABLED: types<void>(),
				REALTIME_ENABLED: types<void>(),
				SOCKET_OPENED: types<void>(),
				SOCKET_CLOSED: types<{
					code: number;
					reason: string;
					wasClean: boolean;
				}>(),
				SOCKET_MESSAGE: types<{ message: SyncMessage }>(),
				OUTBOX_ACKNOWLEDGED: types<{ outboxId: string }>(),
				OUTBOX_REPLAYED: types<void>(),
				ACCESS_REVOKED: types<void>(),
				COLUMN_DELETED: types<void>(),
			},
		},
		actors: {
			authorizeSocket: createAsyncLogic({
				run: ({
					input,
					signal,
				}: {
					input: { accountId: string; columnId: string };
					signal: AbortSignal;
				}) =>
					dependencies.getSocketUrl(
						input.accountId,
						input.columnId,
						signal
					),
			}),
			columnSocket: columnSocketActor,
			terminalCleanup: createAsyncLogic({
				run: async ({
					input,
				}: {
					input: {
						columnId: string;
						reason: ColumnTerminationReason;
					};
				}) => {
					await dependencies.onTerminate(
						input.columnId,
						input.reason
					);
				},
			}),
		},
		delays: {
			retryDelay: ({ context }) =>
				Math.min(
					1_000 * 2 ** Math.max(0, context.retryAttempt - 1),
					30_000
				),
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
			ACCESS_REVOKED: () => ({
				target: ".terminating",
				context: actions.setRevoked(),
			}),
			COLUMN_DELETED: () => ({
				target: ".terminating",
				context: actions.setDeleted(),
			}),
		},
		states: {
			inactive: {
				on: {
					SUBSCRIBE: (args) => {
						if (args.guards.canConnectAfterSubscribe(args)) {
							return {
								target: "active",
								context: actions.addLease(args),
							};
						}
						return {
							target: "paused",
							context: actions.addLease(args),
						};
					},
					UNSUBSCRIBE: (args) => ({
						context: actions.removeLease(args),
					}),
					SEND_SYNC: (args, enq) => {
						enq(actions.persistSync, args);
					},
					SEND_AWARENESS: (args, enq) => {
						enq(actions.persistAwareness, args);
						return { context: actions.rememberAwareness(args) };
					},
					NETWORK_OFFLINE: () => ({
						context: actions.setNetworkOffline(),
					}),
					NETWORK_ONLINE: () => ({
						context: actions.setNetworkOnline(),
					}),
					REALTIME_DISABLED: () => ({
						context: actions.setRealtimeDisabled(),
					}),
					REALTIME_ENABLED: () => ({
						context: actions.setRealtimeEnabled(),
					}),
				},
			},
			active: {
				initial: "authorizing",
				on: {
					OUTBOX_ACKNOWLEDGED: (args, enq) => {
						enq(actions.acknowledgeOutbox, args);
					},
					SUBSCRIBE: (args) => ({ context: actions.addLease(args) }),
					UNSUBSCRIBE: (args) => {
						if (args.guards.isLastLease(args)) {
							return {
								target: "inactive",
								context: actions.removeLease(args),
							};
						}
						return { context: actions.removeLease(args) };
					},
					NETWORK_OFFLINE: () => ({
						target: "paused",
						context: actions.setNetworkOffline(),
					}),
					REALTIME_DISABLED: () => ({
						target: "paused",
						context: actions.setRealtimeDisabled(),
					}),
					SEND_SYNC: (args, enq) => {
						enq(actions.persistSync, args);
					},
					SEND_AWARENESS: (args, enq) => {
						enq(actions.persistAwareness, args);
						return { context: actions.rememberAwareness(args) };
					},
					SOCKET_CLOSED: (args) => ({
						target: "reconnectDelay",
						context: actions.recordClose(args),
					}),
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
							onDone: (args) => ({
								target: "transport",
								context: actions.recordSocketUrl(
									args.event.output
								),
							}),
							onError: (args, enq) => {
								const { event } = args;
								if (
									event.error instanceof
										ColumnSocketAuthorizationError &&
									event.error.reason === "reauth_required"
								) {
									enq(actions.notifyAuthenticationRequired);
									return {
										target: "#columnSession.paused",
										context: actions.setRealtimeDisabled(),
									};
								}
								if (
									event.error instanceof
										ColumnSocketAuthorizationError &&
									event.error.reason === "column_deleted"
								) {
									return {
										target: "#columnSession.terminating",
										context: actions.setDeleted(),
									};
								}
								if (
									event.error instanceof
										ColumnSocketAuthorizationError &&
									event.error.reason === "revoked"
								) {
									return {
										target: "#columnSession.terminating",
										context: actions.setRevoked(),
									};
								}
								return {
									target: "#columnSession.reconnectDelay",
									context:
										actions.recordAuthorizationFailure(
											args
										),
								};
							},
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
								on: { SOCKET_OPENED: { target: "replaying" } },
							},
							replaying: {
								on: {
									OUTBOX_REPLAYED: () => ({
										target: "connected",
										context: actions.markConnected(),
									}),
								},
							},
							connected: {
								on: {
									SOCKET_MESSAGE: (args, enq) => {
										const patch =
											actions.recordPresence(args);
										const context = {
											...args.context,
											...patch,
										};
										enq(actions.forwardMessage, {
											...args,
											context,
										});
										return { context: patch };
									},
									SEND_SYNC: (args, enq) => {
										enq(actions.sendLiveSync, args);
									},
									SEND_AWARENESS: (args, enq) => {
										enq(actions.sendLiveAwareness, args);
									},
								},
							},
						},
					},
				},
			},
			reconnectDelay: {
				id: "columnSession.reconnectDelay",
				after: {
					retryDelay: (args) => {
						if (!args.guards.canConnect(args)) return;
						return { target: "active" };
					},
				},
				on: {
					SUBSCRIBE: (args) => ({ context: actions.addLease(args) }),
					UNSUBSCRIBE: (args) => {
						if (args.guards.isLastLease(args)) {
							return {
								target: "inactive",
								context: actions.removeLease(args),
							};
						}
						return { context: actions.removeLease(args) };
					},
					SEND_SYNC: (args, enq) => {
						enq(actions.persistSync, args);
					},
					SEND_AWARENESS: (args, enq) => {
						enq(actions.persistAwareness, args);
						return { context: actions.rememberAwareness(args) };
					},
					NETWORK_OFFLINE: () => ({
						target: "paused",
						context: actions.setNetworkOffline(),
					}),
					REALTIME_DISABLED: () => ({
						target: "paused",
						context: actions.setRealtimeDisabled(),
					}),
				},
			},
			paused: {
				id: "columnSession.paused",
				on: {
					SUBSCRIBE: (args) => ({ context: actions.addLease(args) }),
					UNSUBSCRIBE: (args) => {
						if (args.guards.isLastLease(args)) {
							return {
								target: "inactive",
								context: actions.removeLease(args),
							};
						}
						return { context: actions.removeLease(args) };
					},
					SEND_SYNC: (args, enq) => {
						enq(actions.persistSync, args);
					},
					SEND_AWARENESS: (args, enq) => {
						enq(actions.persistAwareness, args);
						return { context: actions.rememberAwareness(args) };
					},
					NETWORK_OFFLINE: () => ({
						context: actions.setNetworkOffline(),
					}),
					REALTIME_DISABLED: () => ({
						context: actions.setRealtimeDisabled(),
					}),
					NETWORK_ONLINE: (args) => {
						if (args.guards.canConnectAfterOnline(args)) {
							return {
								target: "active",
								context: actions.setNetworkOnline(),
							};
						}
						return { context: actions.setNetworkOnline() };
					},
					REALTIME_ENABLED: (args) => {
						if (args.guards.canConnectAfterEnabled(args)) {
							return {
								target: "active",
								context: actions.setRealtimeEnabled(),
							};
						}
						return { context: actions.setRealtimeEnabled() };
					},
				},
			},
			terminating: {
				id: "columnSession.terminating",
				invoke: {
					src: "terminalCleanup",
					input: ({ context }) => ({
						columnId: context.columnId,
						reason: context.terminationReason ?? "revoked",
					}),
					onDone: { target: "terminated" },
					onError: { target: "terminated" },
				},
			},
			terminated: { type: "final" },
		},
	});
}

export function columnSessionConnectionStatus(snapshot: {
	matches(value: unknown): boolean;
}): ConnectionStatus {
	if (snapshot.matches({ active: { transport: "connected" } }))
		return "connected";
	if (
		snapshot.matches({ active: "authorizing" }) ||
		snapshot.matches({ active: { transport: "connecting" } }) ||
		snapshot.matches({ active: { transport: "replaying" } })
	) {
		return "connecting";
	}
	return "offline";
}
