import { assign, fromPromise, setup } from "xstate";
import {
	applyAccountCommand,
	applyCommandEffects,
	applyPendingCommands,
	removeColumnFromProjection,
	type AccountProjection,
} from "./account-projection";
import { summarizeReplayReport } from "./account-command-reconciliation";
import type { QueuedMutation, ReplayReport } from "./contracts";

export type AccountConvergenceError =
	| { scope: "auth"; kind: "invalid" | "not_found" }
	| { scope: "hydrate"; kind: "offline" | "rate_limited" | "server" }
	| { scope: "replay"; kind: "retryable" | "terminal" }
	| { scope: "access"; kind: "revoked"; columnId: string };

export class AccountConvergenceFailure extends Error {
	readonly convergenceError: AccountConvergenceError;

	constructor(error: AccountConvergenceError, message: string) {
		super(message);
		this.name = "AccountConvergenceFailure";
		this.convergenceError = error;
	}
}

export interface AccountConvergenceContext {
	accountId: string | null;
	serverBase: AccountProjection | null;
	projection: AccountProjection | null;
	queueDepth: number;
	lastConvergedAt: number | null;
	lastReplayAt: number | null;
	error: AccountConvergenceError | null;
	networkOnline: boolean;
	retryAt: number | null;
	lastReplayReport: ReplayReport | null;
	accessLostColumnIds: string[];
	retryKind: "hydrate" | "replay";
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
		signal: AbortSignal,
	): Promise<AccountProjection | null>;
	fetchServer(
		accountId: string,
		signal: AbortSignal,
	): Promise<AccountProjection>;
	login(accountId: string, signal: AbortSignal): Promise<AccountProjection>;
	createAccount(signal: AbortSignal): Promise<AccountProjection>;
	replay(accountId: string, signal: AbortSignal): Promise<ReplayReport>;
	getPending(accountId: string): QueuedMutation[];
	getNextRetryAt(accountId: string): number | null;
	persistCredential(accountId: string | null): void;
	reconcileAccessLoss(
		accountId: string,
		columnIds: string[],
	): Promise<void>;
	now?: () => number;
}

function failureFromUnknown(
	error: unknown,
	fallback: AccountConvergenceError,
): AccountConvergenceError {
	return error instanceof AccountConvergenceFailure
		? error.convergenceError
		: fallback;
}

function accountIdOrThrow(context: AccountConvergenceContext): string {
	if (!context.accountId) throw new Error("Account session is not active");
	return context.accountId;
}

export function createAccountConvergenceMachine(
	dependencies: AccountConvergenceDependencies,
) {
	const now = dependencies.now ?? Date.now;

	const queueState = (accountId: string | null) => {
		if (!accountId) return { queueDepth: 0, retryAt: null };
		return {
			queueDepth: dependencies.getPending(accountId).length,
			retryAt: dependencies.getNextRetryAt(accountId),
		};
	};

	const projectPending = (
		base: AccountProjection | null,
		accountId: string | null,
	) => {
		if (!base || !accountId) return base;
		return applyPendingCommands(base, dependencies.getPending(accountId));
	};

	return setup({
		types: {} as {
			context: AccountConvergenceContext;
			input: AccountConvergenceInput;
			events: AccountConvergenceEvent;
			actions:
				| { type: "installAuthenticatedProjection"; params: AccountProjection }
				| {
						type: "installLocalProjection";
						params: AccountProjection | null;
				  }
				| { type: "installServerProjection"; params: AccountProjection }
				| { type: "recordReplay"; params: ReplayReport }
				| { type: "recordHydrationFailure"; params: unknown }
				| { type: "recordAuthFailure"; params: unknown };
		},
		actors: {
			loadLocal: fromPromise<
				AccountProjection | null,
				{ accountId: string }
			>(({ input, signal }) => dependencies.loadLocal(input.accountId, signal)),
			fetchServer: fromPromise<AccountProjection, { accountId: string }>(
				({ input, signal }) => dependencies.fetchServer(input.accountId, signal),
			),
			login: fromPromise<AccountProjection, { accountId: string }>(
				({ input, signal }) => dependencies.login(input.accountId, signal),
			),
			createAccount: fromPromise<AccountProjection, Record<string, never>>(
				({ signal }) => dependencies.createAccount(signal),
			),
			replay: fromPromise<ReplayReport, { accountId: string }>(
				({ input, signal }) => dependencies.replay(input.accountId, signal),
			),
			reconcileAccessLoss: fromPromise<
				void,
				{ accountId: string; columnIds: string[] }
			>(({ input }) =>
				dependencies.reconcileAccessLoss(input.accountId, input.columnIds),
			),
		},
		delays: {
			nextRetryDelay: ({ context }) =>
				Math.max(0, (context.retryAt ?? now() + 5_000) - now()),
		},
		guards: {
			isOnline: ({ context }) => context.networkOnline,
			hasAccountSession: ({ context }) => context.accountId !== null,
			retryHydration: ({ context }) => context.retryKind === "hydrate",
			hasPending: ({ context }) => context.queueDepth > 0,
			replayHadAttempts: ({ context }) =>
				(context.lastReplayReport?.attempted ?? 0) > 0,
			isNotFoundFailure: ({ event }) =>
				event.type.startsWith("xstate.error.actor") &&
				failureFromUnknown((event as { error?: unknown }).error, {
					scope: "hydrate",
					kind: "server",
				}).kind === "not_found",
		},
		actions: {
			beginRestoredSession: assign(({ event }) => {
				if (event.type !== "RESTORE_SESSION") return {};
				return {
					accountId: event.accountId,
					serverBase: null,
					projection: null,
					error: null,
					lastReplayReport: null,
					accessLostColumnIds: [],
					retryKind: "hydrate" as const,
					...queueState(event.accountId),
				};
			}),
			setAuthCandidate: assign(({ event }) => ({
				authCandidate: event.type === "LOGIN" ? event.accountId : null,
				error: null,
			})),
			installAuthenticatedProjection: assign(
				(_, projection: AccountProjection) => {
				const accountId = projection.account.id;
				dependencies.persistCredential(accountId);
				return {
					accountId,
					serverBase: projection,
					projection: projectPending(projection, accountId),
					authCandidate: null,
					error: null,
					accessLostColumnIds: [],
					retryKind: "hydrate" as const,
					...queueState(accountId),
				};
				},
			),
			installLocalProjection: assign(
				({ context }, local: AccountProjection | null) => {
				const base = context.serverBase ?? local;
				return {
					serverBase: base,
					projection: projectPending(base, context.accountId),
					...queueState(context.accountId),
				};
				},
			),
			installServerProjection: assign(
				({ context }, fetched: AccountProjection) => {
				const fetchedSharedIds = new Set(
					fetched.sharedColumns.map((column) => column.id),
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
					projection: projectPending(base, context.accountId),
					accessLostColumnIds,
					error: retainedError,
					...queueState(context.accountId),
				};
				},
			),
			recordReplay: assign(({ context }, report: ReplayReport) => {
				return {
					lastReplayReport: report,
					lastReplayAt: now(),
					retryKind: "replay" as const,
					...queueState(context.accountId),
				};
			}),
			applyReplayReport: assign(({ context }) => {
				const report = context.lastReplayReport;
				if (!report || !context.serverBase) return {};
				let base = report.ackedCommands.reduce(
					applyAccountCommand,
					context.serverBase,
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
								columnId: accessLostColumnIds[0]!,
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
			}),
			refreshProjection: assign(({ context }) => ({
				projection: projectPending(context.serverBase, context.accountId),
				...queueState(context.accountId),
			})),
			removeRevokedColumn: assign(({ context, event }) => {
				if (event.type !== "ACCESS_REVOKED" || !context.serverBase) return {};
				const base = removeColumnFromProjection(
					context.serverBase,
					event.columnId,
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
			}),
			removeDeletedColumn: assign(({ context, event }) => {
				if (event.type !== "COLUMN_DELETED" || !context.serverBase) return {};
				const base = removeColumnFromProjection(
					context.serverBase,
					event.columnId,
				);
				return {
					serverBase: base,
					projection: projectPending(base, context.accountId),
				};
			}),
			setOnline: assign({ networkOnline: true }),
			setOffline: assign({ networkOnline: false }),
			clearError: assign({ error: null }),
			markConverged: assign({
				lastConvergedAt: () => now(),
				accessLostColumnIds: [],
				error: ({ context }) =>
					context.error?.scope === "replay" &&
					context.error.kind === "terminal"
						? context.error
						: null,
			}),
			recordHydrationFailure: assign((_, error) => ({
				error: failureFromUnknown(error, {
					scope: "hydrate",
					kind: "server",
				}),
				retryKind: "hydrate" as const,
			})),
			recordAuthFailure: assign((_, error) => ({
				error: failureFromUnknown(error, {
					scope: "auth",
					kind: "not_found",
				}),
			})),
			clearSession: assign(() => {
				dependencies.persistCredential(null);
				return {
					accountId: null,
					serverBase: null,
					projection: null,
					queueDepth: 0,
					retryAt: null,
					lastConvergedAt: null,
					lastReplayAt: null,
					lastReplayReport: null,
					accessLostColumnIds: [],
					retryKind: "hydrate" as const,
					authCandidate: null,
				};
			}),
		},
	}).createMachine({
		id: "accountConvergence",
		context: ({ input }) => ({
			accountId: input.restoredAccountId ?? null,
			serverBase: null,
			projection: null,
			queueDepth: 0,
			lastConvergedAt: null,
			lastReplayAt: null,
			error: null,
			networkOnline: input.networkOnline,
			retryAt: null,
			lastReplayReport: null,
			accessLostColumnIds: [],
			retryKind: "hydrate",
			authCandidate: null,
		}),
		initial: "signedOut",
		on: {
			LOGOUT: { target: ".signingOut", actions: "clearError" },
			ACCESS_REVOKED: { actions: "removeRevokedColumn" },
			COLUMN_DELETED: { actions: "removeDeletedColumn" },
		},
		states: {
			signedOut: {
				always: {
					guard: "hasAccountSession",
					target: "loadingLocal",
				},
				on: {
					RESTORE_SESSION: {
						target: "loadingLocal",
						actions: "beginRestoredSession",
					},
					LOGIN: {
						target: "authenticating.login",
						actions: "setAuthCandidate",
					},
					CREATE_ACCOUNT: { target: "authenticating.create" },
					NETWORK_ONLINE: { actions: "setOnline" },
					NETWORK_OFFLINE: { actions: "setOffline" },
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
							onDone: {
								target: "#accountConvergence.loadingLocal",
								actions: {
									type: "installAuthenticatedProjection",
									params: ({ event }) => event.output,
								},
							},
							onError: {
								target: "#accountConvergence.signedOut",
								actions: {
									type: "recordAuthFailure",
									params: ({ event }) => event.error,
								},
							},
						},
					},
					create: {
						invoke: {
							src: "createAccount",
							input: {},
							onDone: {
								target: "#accountConvergence.loadingLocal",
								actions: {
									type: "installAuthenticatedProjection",
									params: ({ event }) => event.output,
								},
							},
							onError: {
								target: "#accountConvergence.signedOut",
								actions: {
									type: "recordAuthFailure",
									params: ({ event }) => event.error,
								},
							},
						},
					},
				},
			},
			loadingLocal: {
				invoke: {
					src: "loadLocal",
					input: ({ context }) => ({ accountId: accountIdOrThrow(context) }),
					onDone: [
						{
							guard: "isOnline",
							target: "hydratingServer",
							actions: {
								type: "installLocalProjection",
								params: ({ event }) => event.output,
							},
						},
						{
							target: "readyOffline",
							actions: {
								type: "installLocalProjection",
								params: ({ event }) => event.output,
							},
						},
					],
					onError: [
						{ guard: "isOnline", target: "hydratingServer" },
						{ target: "readyOffline" },
					],
				},
				on: {
					NETWORK_OFFLINE: { actions: "setOffline" },
					NETWORK_ONLINE: { actions: "setOnline" },
					COMMAND_PERSISTED: { actions: "refreshProjection" },
				},
			},
			hydratingServer: {
				invoke: {
					src: "fetchServer",
					input: ({ context }) => ({ accountId: accountIdOrThrow(context) }),
					onDone: {
						target: "replaying",
						actions: {
							type: "installServerProjection",
							params: ({ event }) => event.output,
						},
					},
					onError: [
						{
							guard: "isNotFoundFailure",
							target: "notFound",
						},
						{
							target: "retryScheduled",
							actions: {
								type: "recordHydrationFailure",
								params: ({ event }) => event.error,
							},
						},
					],
				},
				on: {
					NETWORK_OFFLINE: { target: "readyOffline", actions: "setOffline" },
					// A command created while a hydration request is in flight must not be
					// blocked by that request. Exit cancels the stale fetch; replay remains
					// serialized and confirmation installs a fresh server base afterward.
					COMMAND_PERSISTED: {
						target: "replaying",
						actions: "refreshProjection",
					},
				},
			},
			replaying: {
				invoke: {
					src: "replay",
					input: ({ context }) => ({ accountId: accountIdOrThrow(context) }),
					onDone: {
						target: "reconciling",
						actions: {
							type: "recordReplay",
							params: ({ event }) => event.output,
						},
					},
					onError: {
						target: "retryScheduled",
						actions: assign({
							error: { scope: "replay", kind: "retryable" } as const,
							retryKind: "replay" as const,
						}),
					},
				},
				on: {
					NETWORK_OFFLINE: { target: "readyOffline", actions: "setOffline" },
					COMMAND_PERSISTED: { actions: "refreshProjection" },
				},
			},
			reconciling: {
				entry: "applyReplayReport",
				invoke: {
					src: "reconcileAccessLoss",
					input: ({ context }) => ({
						accountId: accountIdOrThrow(context),
						columnIds: context.accessLostColumnIds,
					}),
					onDone: [
						{ guard: "replayHadAttempts", target: "confirmingServer" },
						{ guard: "hasPending", target: "retryScheduled" },
						{ target: "ready", actions: "markConverged" },
					],
					onError: { target: "confirmingServer" },
				},
			},
			confirmingServer: {
				invoke: {
					src: "fetchServer",
					input: ({ context }) => ({ accountId: accountIdOrThrow(context) }),
					onDone: {
						target: "postConvergence",
						actions: {
							type: "installServerProjection",
							params: ({ event }) => event.output,
						},
					},
					onError: [
						{
							guard: "isNotFoundFailure",
							target: "notFound",
						},
						{
							target: "retryScheduled",
							actions: {
								type: "recordHydrationFailure",
								params: ({ event }) => event.error,
							},
						},
					],
				},
				on: {
					NETWORK_OFFLINE: { target: "readyOffline", actions: "setOffline" },
					COMMAND_PERSISTED: { actions: "refreshProjection" },
				},
			},
			postConvergence: {
				always: [
					{ guard: "hasPending", target: "retryScheduled" },
					{ target: "ready", actions: "markConverged" },
				],
			},
			retryScheduled: {
				after: {
					nextRetryDelay: [
						{ guard: "retryHydration", target: "hydratingServer" },
						{ target: "replaying" },
					],
				},
				on: {
					NETWORK_OFFLINE: { target: "readyOffline", actions: "setOffline" },
					COMMAND_PERSISTED: {
						target: "replaying",
						actions: "refreshProjection",
					},
					REFRESH_REQUESTED: "hydratingServer",
					REPLAY_WAKE: "replaying",
				},
			},
			ready: {
				on: {
					COMMAND_PERSISTED: [
						{
							guard: "isOnline",
							target: "replaying",
							actions: "refreshProjection",
						},
						{ target: "readyOffline", actions: "refreshProjection" },
					],
					NETWORK_OFFLINE: { target: "readyOffline", actions: "setOffline" },
					REFRESH_REQUESTED: "hydratingServer",
					REPLAY_WAKE: "replaying",
				},
			},
			readyOffline: {
				on: {
					COMMAND_PERSISTED: { actions: "refreshProjection" },
					NETWORK_ONLINE: { target: "hydratingServer", actions: "setOnline" },
				},
			},
			notFound: {
				entry: assign({
					error: { scope: "auth", kind: "not_found" } as const,
				}),
				always: "signingOut",
			},
			signingOut: {
				entry: "clearSession",
				always: "signedOut",
			},
		},
	});
}
