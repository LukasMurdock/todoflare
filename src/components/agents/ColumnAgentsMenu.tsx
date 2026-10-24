import { useCallback, useEffect, useState } from "react";
import { Bot, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { replaceAgentConnection, useAgentConnections } from "@/hooks/useAgentConnections";
import { agentsApi } from "@/lib/agents/agents-api";
import { useRecentSignIn } from "@/hooks/use-recent-sign-in";
import { ConfirmSignIn } from "@/components/account/ConfirmSignIn";
import type { AgentChange, AgentGrantLevel } from "@/lib/api/agent-contract";
import { AgentChangeDiffView } from "./AgentChangeDiff";
import { AgentLevelSelect } from "./AgentLevelSelect";

interface ColumnAgentsMenuProps {
	accountId: string;
	columnId: string;
}

function when(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(timestamp);
}

function undoneLabel(change: AgentChange): string {
	if (!change.undoResult) return "Undone";
	const { restored, kept } = change.undoResult;
	return kept > 0 ? `Undone · kept ${kept} edited since` : restored > 0 ? "Undone" : "Undone · nothing left to revert";
}

/**
 * Which agents may use this column, and what they did to it. Rendered only
 * when agent access is available; any member of the column can undo.
 */
export function ColumnAgentsMenu({ accountId, columnId }: ColumnAgentsMenuProps) {
	const { state } = useAgentConnections(accountId, true);
	const [open, setOpen] = useState(false);
	const [changes, setChanges] = useState<AgentChange[] | null>(null);
	const [busy, setBusy] = useState(false);
	// Widening an agent's access needs a recent sign-in.
	const recent = useRecentSignIn(accountId);
	const { cancel } = recent;
	// While a refused change waits for confirmation, nothing else may change.
	const locked = busy || recent.pending;
	useEffect(() => {
		if (!open) cancel();
	}, [open, cancel]);

	const loadChanges = useCallback(() => {
		agentsApi.changes(accountId, columnId).then(setChanges, () => setChanges([]));
	}, [accountId, columnId]);

	useEffect(() => {
		if (open) loadChanges();
	}, [open, loadChanges]);

	if (state.status !== "ready") return null;
	const agents = state.agents;
	const activeHere = agents.filter((agent) => agent.grants.some((grant) => grant.columnId === columnId));

	const setLevel = async (agentId: string, level: AgentGrantLevel | null) => {
		setBusy(true);
		try {
			if (level) {
				await recent.attempt(async () => {
					replaceAgentConnection(accountId, await agentsApi.setGrant(accountId, agentId, columnId, level));
				}, "Could not change access");
			} else {
				replaceAgentConnection(accountId, await agentsApi.removeGrant(accountId, agentId, columnId));
			}
		} catch (cause) {
			toast.error(cause instanceof Error && cause.message ? cause.message : "Could not change access");
		} finally {
			setBusy(false);
		}
	};

	const confirm = async () => {
		setBusy(true);
		try {
			await recent.confirm();
		} catch (cause) {
			toast.error(cause instanceof Error && cause.message ? cause.message : "Could not change access");
		} finally {
			setBusy(false);
		}
	};

	const undo = async (change: AgentChange) => {
		setBusy(true);
		try {
			const result = await agentsApi.undo(accountId, columnId, change.id);
			toast.success(result.kept > 0 ? `Undone. Kept ${result.kept} that someone edited since.` : "Undone");
			loadChanges();
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "Could not undo");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button className="relative rounded p-1 hover:bg-muted" aria-label="Agents for this column" title="Agents">
					<Bot className="h-4 w-4 text-muted-foreground" />
					{activeHere.length > 0 && <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden />}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-96" align="end">
				<div className="space-y-4">
					<section className="space-y-2">
						<h4 className="text-sm font-medium">Agent access</h4>
						{agents.length === 0 ? (
							<p className="text-xs text-muted-foreground">No agents connected. Connect one from your account menu → Agents.</p>
						) : (
							agents.map((agent) => (
								<div key={agent.id} className="flex items-center justify-between gap-2">
									<span className="min-w-0 truncate text-sm">{agent.name}</span>
									<AgentLevelSelect
										label={`${agent.name} access to this column`}
										value={agent.grants.find((grant) => grant.columnId === columnId)?.level ?? null}
										disabled={locked}
										onChange={(level) => setLevel(agent.id, level)}
									/>
								</div>
							))
						)}
						{recent.pending && <ConfirmSignIn busy={busy} onConfirm={confirm} onCancel={recent.cancel} />}
					</section>
					<section className="space-y-2 border-t pt-3">
						<h4 className="text-sm font-medium">Recent agent changes</h4>
						{changes === null ? (
							<p className="text-xs text-muted-foreground">Loading…</p>
						) : changes.length === 0 ? (
							<p className="text-xs text-muted-foreground">No agent has changed this column.</p>
						) : (
							<ul className="max-h-96 space-y-2 overflow-y-auto">
								{changes.map((change) => (
									<li key={change.id} className="flex items-start justify-between gap-2 rounded border p-2" data-testid="agent-change">
										<div className="min-w-0 flex-1 space-y-1">
											<p className={change.undoneAt ? "text-sm text-muted-foreground line-through" : "text-sm"}>{change.summary}</p>
											<AgentChangeDiffView diff={change.diff} muted={change.undoneAt !== null} />
											<p className="text-xs text-muted-foreground">
												{change.agentName} · {when(change.createdAt)}
												{change.undoneAt ? ` · ${undoneLabel(change)}` : ""}
											</p>
										</div>
										{!change.undoneAt && (
											<Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" disabled={locked} onClick={() => undo(change)} aria-label={`Undo: ${change.summary}`}>
												<Undo2 className="mr-1 h-3 w-3" />
												Undo
											</Button>
										)}
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			</PopoverContent>
		</Popover>
	);
}
