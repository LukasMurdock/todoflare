import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentConnection } from "@/lib/api/agent-contract";
import { AgentAccessDisabledError, agentsApi } from "@/lib/agents/agents-api";

/**
 * One account's agent connections, shared by every agent control on the page
 * so a change in one (a new grant, a revocation) shows everywhere at once.
 */
export type AgentConnectionsState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "disabled" }
	| { status: "error"; message: string }
	| { status: "ready"; agents: Array<AgentConnection> };

// Snapshots must be referentially stable for useSyncExternalStore.
const IDLE: AgentConnectionsState = { status: "idle" };
let currentAccountId: string | null = null;
let currentValue: AgentConnectionsState = IDLE;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function publish(accountId: string, value: AgentConnectionsState) {
	currentAccountId = accountId;
	currentValue = value;
	for (const listener of listeners) {listener();}
}

export function refreshAgentConnections(accountId: string): Promise<void> {
	if (inFlight && currentAccountId === accountId) {return inFlight;}
	if (currentAccountId !== accountId || currentValue.status === "idle") {publish(accountId, { status: "loading" });}
	inFlight = agentsApi
		.list(accountId)
		.then((agents) => publish(accountId, { status: "ready", agents }))
		.catch((error: unknown) =>
			publish(accountId, error instanceof AgentAccessDisabledError ? { status: "disabled" } : { status: "error", message: error instanceof Error ? error.message : "Could not load agents" }),
		)
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/** Replaces one connection after a successful change, without a reload. */
export function replaceAgentConnection(accountId: string, agent: AgentConnection) {
	if (currentAccountId !== accountId || currentValue.status !== "ready") {return;}
	const agents = currentValue.agents.some((existing) => existing.id === agent.id)
		? currentValue.agents.map((existing) => (existing.id === agent.id ? agent : existing))
		: [...currentValue.agents, agent];
	publish(accountId, { status: "ready", agents });
}

export function removeAgentConnection(accountId: string, agentId: string) {
	if (currentAccountId !== accountId || currentValue.status !== "ready") {return;}
	publish(accountId, { status: "ready", agents: currentValue.agents.filter((agent) => agent.id !== agentId) });
}

export function useAgentConnections(accountId: string | null, enabled: boolean) {
	const value = useSyncExternalStore(subscribe, () => (currentAccountId === accountId ? currentValue : IDLE));
	useEffect(() => {
		if (enabled && accountId && (currentAccountId !== accountId || currentValue.status === "idle")) {void refreshAgentConnections(accountId);}
	}, [accountId, enabled]);
	const refresh = useCallback(() => (accountId ? refreshAgentConnections(accountId) : Promise.resolve()), [accountId]);
	return { state: value, refresh };
}
