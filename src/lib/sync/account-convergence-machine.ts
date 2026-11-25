import { createAsyncLogic, setup, types } from "xstate";
import { normalizeAccountId } from "../account";
import { applyAccountCommand, applyCommandEffects, applyPendingCommands, removeColumnFromProjection } from './account-projection';
import type { AccountProjection } from './account-projection';
import { summarizeReplayReport } from "./account-command-reconciliation";
import type { QueuedMutation, ReplayReport } from "./contracts";

export type AccountConvergenceError =
	| {
			scope: "auth";
			kind: "invalid" | "not_found" | "reauth_required" | "server";
	  }
	| { scope: "hydrate"; kind: "rate_limited" | "server" }
	| { scope: "replay"; kind: "retryable" | "terminal" }
	| { scope: "access"; kind: "revoked"; columnId: string };

export class AccountConvergenceFailure extends Error {
	readonly convergenceError: AccountConvergenceError;
	readonly retryAfterMs: number | null;

	constructor(
		error: AccountConvergenceError,
		message: string,
		retryAfterMs: number | null = null
	) {
		super(message);
		this.name = "AccountConvergenceFailure";
		this.convergenceError = error;
		this.retryAfterMs = retryAfterMs;
	}
}

function isConvergenceFailure(error: unknown): error is AccountConvergenceFailure {
	// oxlint-disable-next-line @nkzw/no-instanceof -- These typed failures are constructed by the actor's own dependencies in the same runtime.
	return error instanceof AccountConvergenceFailure;
}

export interface AccountConvergenceContext {
	accountId: string | null;
	authenticationStatus: "unknown" | "authenticated" | "required";
	serverBase: AccountProjection | null;
	projection: AccountProjection | null;
	queueDepth: number;
	lastConvergedAt: number | null;
	lastReplayAt: number | null;
	replayStartedAt: number | null;
	lastReplayDurationMs: number | null;
	error: AccountConvergenceError | null;
	networkOnline: boolean;
	hydrationRetryAt: number | null;
	replayRetryAt: number | null;
	hydrationFailureCount: number;
	replayFailureCount: number;
	lastReplayReport: ReplayReport | null;
	accessLostColumnIds: Array<string>;
	authCandidate: string | null;
}

export interface AccountConvergenceInput {
	networkOnline: boolean;
	restoredAccountId?: string | null;
}

export type AccountConvergenceEvent =
	| { type: "RESTORE_SESSION"; accountId: string }
	| { type: "LOGIN"; accountId: string }
	| { type: "CREATE_ACCOUNT" }
	| { type: "LOGOUT" }
	| { type: "AUTHENTICATION_REQUIRED" }
	| { type: "NETWORK_ONLINE" }
	| { type: "NETWORK_OFFLINE" }
	| { type: "COMMAND_PERSISTED" }
	| { type: "ACCESS_REVOKED"; columnId: string }
	| { type: "COLUMN_DELETED"; columnId: string }
	| { type: "REPLAY_WAKE" }
	| { type: "REFRESH_REQUESTED" };

export interface AccountConvergenceDependencies {
	loadLocal(
		accountId: string,
		signal: AbortSignal
	): Promise<AccountProjection | null>;
	fetchServer(
		accountId: string,
		signal: AbortSignal
	): Promise<AccountProjection>;
	login(accountId: string, signal: AbortSignal): Promise<AccountProjection>;
	createAccount(signal: AbortSignal): Promise<AccountProjection>;
	replay(accountId: string, signal: AbortSignal): Promise<ReplayReport>;
	getPending(accountId: string): Array<QueuedMutation>;
	getNextRetryAt(accountId: string): number | null;
	persistCredential: (accountId: string | null) => void;
	reconcileAccessLoss(accountId: string, columnIds: Array<string>): Promise<void>;
	now?: () => number;
}

function failureFromUnknown(
	error: unknown,
	fallback: AccountConvergenceError
): AccountConvergenceError {
	return isConvergenceFailure(error)
		? error.convergenceError
		: fallback;
}

function accountIdOrThrow(context: AccountConvergenceContext): string {
	if (!context.accountId) {throw new Error("Account session is not active");}
	return context.accountId;
}

export function createAccountConvergenceMachine(
	dependencies: AccountConvergenceDependencies
) {
	const now = dependencies.now ?? Date.now;

	const queueState = (accountId: string | null) => {
		if (!accountId) {return { queueDepth: 0, replayRetryAt: null };}
		return {
			queueDepth: dependencies.getPending(accountId).length,
			replayRetryAt: dependencies.getNextRetryAt(accountId),
		};
	};

	const projectPending = (
		base: AccountProjection | null,
		accountId: string | null
	) => {
		if (!base || !accountId) {return base;}
		return applyPendingCommands(base, dependencies.getPending(accountId));
	};

	const actions = {
		beginRestoredSession: ({
			event,
		}: {
			event: AccountConvergenceEvent;
		}) => {
			if (event.type !== "RESTORE_SESSION") {return {};}
			return {
				accountId: event.accountId,
				authenticationStatus: "unknown" as const,
				serverBase: null,
				projection: null,
				error: null,
				lastReplayReport: null,
				replayStartedAt: null,
				lastReplayDurationMs: null,
				accessLostColumnIds: [],
				hydrationRetryAt: null,
				hydrationFailureCount: 0,
				replayFailureCount: 0,
				...queueState(event.accountId),
			};
		},
		setAuthCandidate: ({ event }: { event: AccountConvergenceEvent }) => ({
			authCandidate: event.type === "LOGIN" ? event.accountId : null,
			error: null,
		}),
		installAuthenticatedProjection: (projection: AccountProjection) => {
			const accountId = projection.account.id;
			return {
				accountId,
				authenticationStatus: "authenticated" as const,
				serverBase: projection,
				projection: projectPending(projection, accountId),
				authCandidate: null,
				error: null,
				accessLostColumnIds: [],
				replayStartedAt: null,
				lastReplayDurationMs: null,
				hydrationRetryAt: null,
				hydrationFailureCount: 0,
				replayFailureCount: 0,
				...queueState(accountId),
			};
		},
		installLocalProjection: (
			{ context }: { context: AccountConvergenceContext },
			local: AccountProjection | null
		) => {
			const base = context.serverBase ?? local;
			return {
				serverBase: base,
				projection: projectPending(base, context.accountId),
				...queueState(context.accountId),
			};
		},
		installServerProjection: (
			{ context }: { context: AccountConvergenceContext },
			fetched: AccountProjection
		) => {
			const fetchedSharedIds = new Set(
				fetched.sharedColumns.map((column) => column.id)
			);
			const accessLostColumnIds = (
				context.serverBase?.sharedColumns ?? []
			)
				.map((column) => column.id)
				.filter((columnId) => !fetchedSharedIds.has(columnId));
			const base = fetched;
			const retainedError =
				context.error?.scope === "replay" &&
				context.error.kind === "terminal"
					? context.error
					: null;
			return {
				serverBase: base,
				authenticationStatus: "authenticated" as const,
				projection: projectPending(base, context.accountId),
				accessLostColumnIds,
				error: retainedError,
				hydrationRetryAt: null,
				hydrationFailureCount: 0,
				...queueState(context.accountId),
			};
		},
		markReplayStarted: () => ({ replayStartedAt: now() }),
		recordReplay: (
			{ context }: { context: AccountConvergenceContext },
			report: ReplayReport
		) => {
			const finishedAt = now();
			return {
				lastReplayReport: report,
				lastReplayAt: finishedAt,
				lastReplayDurationMs:
					context.replayStartedAt === null
						? null
						: Math.max(0, finishedAt - context.replayStartedAt),
				replayStartedAt: null,
				replayFailureCount: 0,
				...queueState(context.accountId),
			};
		},
		recordReplayFailure: ({
			context,
		}: {
			context: AccountConvergenceContext;
		}) => {
			const failureCount = context.replayFailureCount + 1;
			const queue = queueState(context.accountId);
			const fallbackRetryAt =
				now() +
				Math.min(30_000, 5000 * 2 ** Math.max(0, failureCount - 1));
			return {
				error: { scope: "replay", kind: "retryable" } as const,
				...queue,
				replayFailureCount: failureCount,
				replayStartedAt: null,
				replayRetryAt:
					queue.replayRetryAt !== null && queue.replayRetryAt > now()
						? queue.replayRetryAt
						: fallbackRetryAt,
			};
		},
		applyReplayReport: ({
			context,
		}: {
			context: AccountConvergenceContext;
		}) => {
			const report = context.lastReplayReport;
			if (!report || !context.serverBase) {return {};}
			let base = report.ackedCommands.reduce(
				applyAccountCommand,
				context.serverBase
			);
			base = applyCommandEffects(base, report.effects);
			const reconciliation = summarizeReplayReport(report);
			const accessLostColumnIds = [
				...new Set([
					...context.accessLostColumnIds,
					...reconciliation.accessLostColumnIds,
				]),
			];
			for (const columnId of accessLostColumnIds) {
				base = removeColumnFromProjection(base, columnId);
			}
			const error: AccountConvergenceError | null =
				accessLostColumnIds.length > 0
					? {
							scope: "access",
							kind: "revoked",
							columnId: accessLostColumnIds[0],
						}
					: reconciliation.nonAccessLossFailureCount > 0
						? { scope: "replay", kind: "terminal" }
						: report.retried > 0
							? { scope: "replay", kind: "retryable" }
							: null;
			return {
				serverBase: base,
				projection: projectPending(base, context.accountId),
				accessLostColumnIds,
				error,
				...queueState(context.accountId),
			};
		},
		refreshProjection: ({
			context,
		}: {
			context: AccountConvergenceContext;
		}) => ({
			projection: projectPending(context.serverBase, context.accountId),
			...queueState(context.accountId),
		}),
		removeRevokedColumn: ({
			context,
			event,
		}: {
			context: AccountConvergenceContext;
			event: AccountConvergenceEvent;
		}) => {
			if (event.type !== "ACCESS_REVOKED" || !context.serverBase)
				{return {};}
			const base = removeColumnFromProjection(
				context.serverBase,
				event.columnId
			);
			return {
				serverBase: base,
				projection: projectPending(base, context.accountId),
				error: {
					scope: "access",
					kind: "revoked",
					columnId: event.columnId,
				} as const,
			};
		},
		removeDeletedColumn: ({
			context,
			event,
		}: {
			context: AccountConvergenceContext;
			event: AccountConvergenceEvent;
		}) => {
			if (event.type !== "COLUMN_DELETED" || !context.serverBase)
				{return {};}
			const base = removeColumnFromProjection(
				context.serverBase,
				event.columnId
			);
			return {
				serverBase: base,
				projection: projectPending(base, context.accountId),
			};
		},
		setOnline: () => ({ networkOnline: true }),
		setOffline: () => ({ networkOnline: false }),
		clearError: () => ({ error: null }),
		markConverged: ({
			context,
		}: {
			context: AccountConvergenceContext;
		}) => ({
			lastConvergedAt: now(),
			accessLostColumnIds: [],
			error:
				context.error?.scope === "replay" &&
				context.error.kind === "terminal"
					? context.error
					: null,
		}),
		recordHydrationFailure: (
			{ context }: { context: AccountConvergenceContext },
			error: unknown
		) => {
			const failureCount = context.hydrationFailureCount + 1;
			const retryAfterMs =
				isConvergenceFailure(error)
					? error.retryAfterMs
					: null;
			const fallbackDelay = Math.min(
				30_000,
				5000 * 2 ** Math.max(0, failureCount - 1)
			);
			return {
				error: failureFromUnknown(error, {
					scope: "hydrate",
					kind: "server",
				}),
				hydrationFailureCount: failureCount,
				hydrationRetryAt: now() + (retryAfterMs ?? fallbackDelay),
			};
		},
		recordAuthFailure: (error: unknown) => ({
			error: failureFromUnknown(error, {
				scope: "auth",
				kind: "server",
			}),
		}),
		clearSession: () => ({
			accountId: null,
			authenticationStatus: "unknown" as const,
			serverBase: null,
			projection: null,
			queueDepth: 0,
			hydrationRetryAt: null,
			replayRetryAt: null,
			hydrationFailureCount: 0,
			replayFailureCount: 0,
			lastConvergedAt: null,
			lastReplayAt: null,
			replayStartedAt: null,
			lastReplayDurationMs: null,
			lastReplayReport: null,
			accessLostColumnIds: [],
			authCandidate: null,
		}),
	};

	return setup({
		schemas: {
			context: types<AccountConvergenceContext>(),
			input: types<AccountConvergenceInput>(),
			events: {
				RESTORE_SESSION: types<{ accountId: string }>(),
				LOGIN: types<{ accountId: string }>(),
				CREATE_ACCOUNT: types<void>(),
				LOGOUT: types<void>(),
				AUTHENTICATION_REQUIRED: types<void>(),
				NETWORK_ONLINE: types<void>(),
				NETWORK_OFFLINE: types<void>(),
				COMMAND_PERSISTED: types<void>(),
				ACCESS_REVOKED: types<{ columnId: string }>(),
				COLUMN_DELETED: types<{ columnId: string }>(),
				REPLAY_WAKE: types<void>(),
				REFRESH_REQUESTED: types<void>(),
			},
		},
		actors: {
			loadLocal: createAsyncLogic({
				run: ({
					input,
					signal,
				}: {
					input: { accountId: string };
					signal: AbortSignal;
				}) => dependencies.loadLocal(input.accountId, signal),
			}),
			fetchServer: createAsyncLogic({
				run: ({
					input,
					signal,
				}: {
					input: { accountId: string };
					signal: AbortSignal;
				}) => dependencies.fetchServer(input.accountId, signal),
			}),
			login: createAsyncLogic({
				run: ({
					input,
					signal,
				}: {
					input: { accountId: string };
					signal: AbortSignal;
				}) => dependencies.login(input.accountId, signal),
			}),
			createAccount: createAsyncLogic<
				AccountProjection,
				Record<string, never>
			>({ run: ({ signal }) => dependencies.createAccount(signal) }),
			replay: createAsyncLogic({
				run: ({
					input,
					signal,
				}: {
					input: { accountId: string };
					signal: AbortSignal;
				}) => dependencies.replay(input.accountId, signal),
			}),
			reconcileAccessLoss: createAsyncLogic({
				run: ({
					input,
				}: {
					input: { accountId: string; columnIds: Array<string> };
				}) =>
					dependencies.reconcileAccessLoss(
						input.accountId,
						input.columnIds
					),
			}),
		},
		delays: {
			hydrationRetryDelay: ({ context }) =>
				Math.max(
					0,
					(context.hydrationRetryAt ?? now() + 5000) - now()
				),
			replayRetryDelay: ({ context }) =>
				Math.max(0, (context.replayRetryAt ?? now() + 5000) - now()),
		},
		guards: {
			isOnline: ({ context }: { context: AccountConvergenceContext }) => context.networkOnline,
			canAttemptReplay: ({ context }: { context: AccountConvergenceContext }) =>
				context.authenticationStatus !== "required",
			isOffline: ({ context }: { context: AccountConvergenceContext }) => !context.networkOnline,
			hasAccountSession: ({ context }: { context: AccountConvergenceContext }) => context.accountId !== null,
			hasPending: ({ context }: { context: AccountConvergenceContext }) => context.queueDepth > 0,
			replayHadAttempts: ({ context }: { context: AccountConvergenceContext }) =>
				(context.lastReplayReport?.attempted ?? 0) > 0,
			isSameAccountLogin: ({ context, event }: { context: AccountConvergenceContext; event: AccountConvergenceEvent }) =>
				event.type === "LOGIN" &&
				!!context.accountId &&
				normalizeAccountId(event.accountId) ===
					normalizeAccountId(context.accountId),
		},
	}).createMachine({
		id: "accountConvergence",
		context: ({ input }) => ({
			accountId: input.restoredAccountId ?? null,
			authenticationStatus: "unknown",
			serverBase: null,
			projection: null,
			queueDepth: 0,
			lastConvergedAt: null,
			lastReplayAt: null,
			replayStartedAt: null,
			lastReplayDurationMs: null,
			error: null,
			networkOnline: input.networkOnline,
			hydrationRetryAt: null,
			replayRetryAt: null,
			hydrationFailureCount: 0,
			replayFailureCount: 0,
			lastReplayReport: null,
			accessLostColumnIds: [],
			authCandidate: null,
		}),
		initial: "signedOut",
		on: {
			LOGOUT: () => ({
				target: ".signingOut",
				context: actions.clearError(),
			}),
			AUTHENTICATION_REQUIRED: (args) => {
				if (!args.guards.hasAccountSession(args)) {return;}
				return { target: ".authenticationRequired" };
			},
			NETWORK_ONLINE: () => ({ context: actions.setOnline() }),
			NETWORK_OFFLINE: () => ({ context: actions.setOffline() }),
			ACCESS_REVOKED: (args) => ({
				context: actions.removeRevokedColumn(args),
			}),
			COLUMN_DELETED: (args) => ({
				context: actions.removeDeletedColumn(args),
			}),
		},
		states: {
			signedOut: {
				id: "accountConvergence.signedOut",
				always: (args) => {
					if (!args.guards.hasAccountSession(args)) {return;}
					return { target: "loadingLocal" };
				},
				on: {
					RESTORE_SESSION: (args) => ({
						target: "loadingLocal",
						context: actions.beginRestoredSession(args),
					}),
					LOGIN: (args) => ({
						target: "authenticating.login",
						context: actions.setAuthCandidate(args),
					}),
					CREATE_ACCOUNT: { target: "authenticating.create" },
					NETWORK_ONLINE: () => ({ context: actions.setOnline() }),
					NETWORK_OFFLINE: () => ({ context: actions.setOffline() }),
				},
			},
			authenticating: {
				initial: "login",
				states: {
					login: {
						invoke: {
							src: "login",
							input: ({ context }) => ({
								accountId: context.authCandidate ?? "",
							}),
							onDone: ({ output }, enq) => {
								enq(
									dependencies.persistCredential,
									output.account.id
								);
								return {
									target: "#accountConvergence.loadingLocal",
									context:
										actions.installAuthenticatedProjection(
											output
										),
								};
							},
							onError: (args) => ({
								target: "#accountConvergence.signedOut",
								context: actions.recordAuthFailure(
									args.event.error
								),
							}),
						},
					},
					create: {
						invoke: {
							src: "createAccount",
							input: {},
							onDone: ({ output }, enq) => {
								enq(
									dependencies.persistCredential,
									output.account.id
								);
								return {
									target: "#accountConvergence.loadingLocal",
									context:
										actions.installAuthenticatedProjection(
											output
										),
								};
							},
							onError: (args) => ({
								target: "#accountConvergence.signedOut",
								context: actions.recordAuthFailure(
									args.event.error
								),
							}),
						},
					},
				},
			},
			loadingLocal: {
				id: "accountConvergence.loadingLocal",
				invoke: {
					src: "loadLocal",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
					}),
					onDone: (args) => {
						const { event } = args;
						if (args.guards.isOnline(args)) {
							return {
								target: "hydratingServer",
								context: actions.installLocalProjection(
									args,
									event.output
								),
							};
						}
						return {
							target: "readyOffline",
							context: actions.installLocalProjection(
								args,
								event.output
							),
						};
					},
					onError: (args) => {
						if (args.guards.isOnline(args)) {
							return { target: "hydratingServer" };
						}
						return { target: "readyOffline" };
					},
				},
				on: {
					NETWORK_OFFLINE: () => ({ context: actions.setOffline() }),
					NETWORK_ONLINE: () => ({ context: actions.setOnline() }),
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
				},
			},
			hydratingServer: {
				id: "accountConvergence.hydratingServer",
				invoke: {
					src: "fetchServer",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
					}),
					onDone: (args) => ({
						target: "replaying",
						context: actions.installServerProjection(
							args,
							args.event.output
						),
					}),
					onError: (args) => {
						if (
							failureFromUnknown(args.event.error, {
								scope: "hydrate",
								kind: "server",
							}).kind === "reauth_required"
						) {
							return { target: "authenticationRequired" };
						}
						if (
							failureFromUnknown(args.event.error, {
								scope: "hydrate",
								kind: "server",
							}).kind === "not_found"
						) {
							return { target: "notFound" };
						}
						return {
							target: "retryScheduled.hydration",
							context: actions.recordHydrationFailure(
								args,
								args.event.error
							),
						};
					},
				},
				on: {
					NETWORK_OFFLINE: () => ({
						target: "readyOffline",
						context: actions.setOffline(),
					}),
					// A new command can cancel stale hydration unless authentication is
					// known to require reconnection. HTTP binds replay to the expected account.
					COMMAND_PERSISTED: (args) => {
						if (args.guards.canAttemptReplay(args)) {
							return {
								target: "replaying",
								context: actions.refreshProjection(args),
							};
						}
						return { context: actions.refreshProjection(args) };
					},
				},
			},
			replaying: {
				id: "accountConvergence.replaying",
				entry: () => ({ context: actions.markReplayStarted() }),
				invoke: {
					src: "replay",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
					}),
					onDone: (args) => {
						const { event } = args;
						if (event.output.authenticationRequired) {
							const replay = actions.recordReplay(
								args,
								event.output
							);
							return {
								target: "authenticationRequired",
								context: {
									...replay,
									...actions.applyReplayReport({
										context: { ...args.context, ...replay },
									}),
								},
							};
						}
						return {
							target: "reconciling",
							context: actions.recordReplay(args, event.output),
						};
					},
					onError: (args) => ({
						target: "retryScheduled.replay",
						context: actions.recordReplayFailure(args),
					}),
				},
				on: {
					NETWORK_OFFLINE: () => ({
						target: "readyOffline",
						context: actions.setOffline(),
					}),
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
				},
			},
			reconciling: {
				entry: (args) => ({ context: actions.applyReplayReport(args) }),
				invoke: {
					src: "reconcileAccessLoss",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
						columnIds: context.accessLostColumnIds,
					}),
					onDone: (args) => {
						if (args.guards.isOffline(args)) {
							return { target: "readyOffline" };
						}
						if (args.guards.replayHadAttempts(args)) {
							return { target: "confirmingServer" };
						}
						if (args.guards.hasPending(args)) {
							return { target: "retryScheduled.replay" };
						}
						return {
							target: "ready",
							context: actions.markConverged(args),
						};
					},
					onError: (args) => {
						if (args.guards.isOffline(args)) {
							return { target: "readyOffline" };
						}
						return { target: "confirmingServer" };
					},
				},
			},
			confirmingServer: {
				invoke: {
					src: "fetchServer",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
					}),
					onDone: (args) => ({
						target: "postConvergence",
						context: actions.installServerProjection(
							args,
							args.event.output
						),
					}),
					onError: (args) => {
						if (
							failureFromUnknown(args.event.error, {
								scope: "hydrate",
								kind: "server",
							}).kind === "reauth_required"
						) {
							return { target: "authenticationRequired" };
						}
						if (
							failureFromUnknown(args.event.error, {
								scope: "hydrate",
								kind: "server",
							}).kind === "not_found"
						) {
							return { target: "notFound" };
						}
						return {
							target: "retryScheduled.hydration",
							context: actions.recordHydrationFailure(
								args,
								args.event.error
							),
						};
					},
				},
				on: {
					NETWORK_OFFLINE: () => ({
						target: "readyOffline",
						context: actions.setOffline(),
					}),
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
				},
			},
			postConvergence: {
				always: (args) => {
					if (args.guards.hasPending(args)) {
						return { target: "retryScheduled.replay" };
					}
					return {
						target: "ready",
						context: actions.markConverged(args),
					};
				},
			},
			retryScheduled: {
				initial: "hydration",
				states: {
					hydration: {
						after: {
							hydrationRetryDelay: {
								target: "#accountConvergence.hydratingServer",
							},
						},
					},
					replay: {
						after: {
							replayRetryDelay: {
								target: "#accountConvergence.replaying",
							},
						},
					},
				},
				on: {
					NETWORK_OFFLINE: () => ({
						target: "readyOffline",
						context: actions.setOffline(),
					}),
					COMMAND_PERSISTED: (args) => {
						if (args.guards.canAttemptReplay(args)) {
							return {
								target: "replaying",
								context: actions.refreshProjection(args),
							};
						}
						return { context: actions.refreshProjection(args) };
					},
					REFRESH_REQUESTED: { target: "hydratingServer" },
					REPLAY_WAKE: (args) => {
						if (!args.guards.canAttemptReplay(args)) {return;}
						return { target: "replaying" };
					},
				},
			},
			ready: {
				on: {
					COMMAND_PERSISTED: (args) => {
						if (args.guards.isOnline(args)) {
							return {
								target: "replaying",
								context: actions.refreshProjection(args),
							};
						}
						return {
							target: "readyOffline",
							context: actions.refreshProjection(args),
						};
					},
					NETWORK_OFFLINE: () => ({
						target: "readyOffline",
						context: actions.setOffline(),
					}),
					REFRESH_REQUESTED: { target: "hydratingServer" },
					REPLAY_WAKE: (args) => {
						if (!args.guards.canAttemptReplay(args)) {return;}
						return { target: "replaying" };
					},
				},
			},
			readyOffline: {
				on: {
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
					NETWORK_ONLINE: () => ({
						target: "hydratingServer",
						context: actions.setOnline(),
					}),
				},
			},
			authenticationRequired: {
				entry: () => ({
					context: {
						authenticationStatus: "required" as const,
						error: {
							scope: "auth",
							kind: "reauth_required",
						} as const,
					},
				}),
				on: {
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
					LOGIN: (args) => {
						if (!args.guards.isSameAccountLogin(args)) {return;}
						return { target: "reconnecting" };
					},
					REFRESH_REQUESTED: (args) => {
						if (!args.guards.isOnline(args)) {return;}
						return { target: "hydratingServer" };
					},
					NETWORK_ONLINE: () => ({ context: actions.setOnline() }),
				},
			},
			reconnecting: {
				invoke: {
					src: "login",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
					}),
					onDone: (args, enq) => {
						enq(
							dependencies.persistCredential,
							args.event.output.account.id
						);
						return {
							target: "replaying",
							context: actions.installAuthenticatedProjection(
								args.event.output
							),
						};
					},
					onError: { target: "authenticationRequired" },
				},
				on: {
					COMMAND_PERSISTED: (args) => ({
						context: actions.refreshProjection(args),
					}),
					NETWORK_OFFLINE: () => ({
						target: "authenticationRequired",
						context: actions.setOffline(),
					}),
				},
			},
			notFound: {
				entry: () => ({
					context: {
						error: {
							scope: "auth",
							kind: "not_found",
						} as const,
					},
				}),
				always: { target: "signingOut" },
			},
			signingOut: {
				entry: (_, enq) => {
					enq(dependencies.persistCredential, null);
					return { context: actions.clearSession() };
				},
				always: { target: "signedOut" },
			},
		},
	});
}
