import { useCallback, useEffect, useState } from "react";
import { Bot, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
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

	const eyebrow = "text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					className="relative rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground"
					aria-label="Agents for this column"
					title="Agents"
				>
					<Bot className="size-4 stroke-[1.75]" />
					{activeHere.length > 0 && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-brand ring-2 ring-background" aria-hidden />}
				</button>
			</PopoverTrigger>
			<PopoverContent
				className="w-[min(24rem,calc(100vw-1.5rem))] p-0 outline-none"
				align="end"
				collisionPadding={12}
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
					<Bot className="size-4 stroke-[1.75] text-muted-foreground" />
					<h3 className="text-[13px] font-semibold">Agents</h3>
					{activeHere.length > 0 && (
						<span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
							<span aria-hidden className="size-1.5 rounded-full bg-brand" />
							{activeHere.length} with access
						</span>
					)}
				</div>
				<div className="flex flex-col gap-4 p-3">
					<section className="flex flex-col gap-2">
						<h4 className={eyebrow}>Agent access</h4>
						{agents.length === 0 ? (
							<p className="text-xs leading-5 text-muted-foreground">No agents connected. Connect one from your account menu → Agents.</p>
						) : (
							<ul className="flex flex-col gap-1">
								{agents.map((agent) => (
									<li key={agent.id} className="flex items-center justify-between gap-2">
										<span className="flex min-w-0 items-center gap-2">
											<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
												<Bot className="size-3.5 stroke-[1.75]" />
											</span>
											<span className="min-w-0 truncate text-[13px]">{agent.name}</span>
										</span>
										<AgentLevelSelect
											label={`${agent.name} access to this column`}
											value={agent.grants.find((grant) => grant.columnId === columnId)?.level ?? null}
											disabled={locked}
											onChange={(level) => setLevel(agent.id, level)}
										/>
									</li>
								))}
							</ul>
						)}
						{recent.pending && <ConfirmSignIn busy={busy} onConfirm={confirm} onCancel={recent.cancel} />}
					</section>
					<section className="flex flex-col gap-2 border-t border-border/60 pt-3">
						<h4 className={eyebrow}>Recent agent changes</h4>
						{changes === null ? (
							<div className="flex flex-col gap-2" aria-busy>
								<p className="sr-only">Loading…</p>
								{[0, 1].map((row) => (
									<div key={row} className="flex gap-2.5" aria-hidden>
										<span className="w-0.5 shrink-0 rounded-full bg-muted" />
										<div className="flex flex-1 flex-col gap-1.5 py-0.5">
											<span className="h-3 w-3/4 animate-pulse rounded bg-muted" />
											<span className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
										</div>
									</div>
								))}
							</div>
						) : changes.length === 0 ? (
							<p className="text-xs text-muted-foreground">No agent has changed this column.</p>
						) : (
							<ul className="-mr-1 flex max-h-96 flex-col gap-3 overflow-y-auto pr-1">
								{changes.map((change) => {
									const undone = change.undoneAt !== null;
									return (
										<li key={change.id} className="flex gap-2.5" data-testid="agent-change">
											<span aria-hidden className={cn("w-0.5 shrink-0 rounded-full", undone ? "bg-border" : "bg-brand/40")} />
											<div className="flex min-w-0 flex-1 flex-col gap-1.5">
												<div className="flex items-start justify-between gap-2">
													<p className={cn("min-w-0 text-[13px] leading-5", undone && "text-muted-foreground line-through")}>{change.summary}</p>
													{!undone && (
														<Button variant="ghost" size="sm" className="-mt-0.5 h-6 shrink-0 gap-1 px-1.5 text-xs" disabled={locked} onClick={() => undo(change)} aria-label={`Undo: ${change.summary}`}>
															<Undo2 className="size-3" />
															Undo
														</Button>
													)}
												</div>
												<AgentChangeDiffView diff={change.diff} muted={undone} />
												<p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
													<span className="font-medium text-foreground/80">{change.agentName}</span>
													<span aria-hidden>·</span>
													<span className="tabular-nums">{when(change.createdAt)}</span>
													{undone && (
														<span className="rounded-full border border-border/70 bg-muted/60 px-1.5 py-px text-[10.5px]">
															{undoneLabel(change)}
														</span>
													)}
												</p>
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				</div>
			</PopoverContent>
		</Popover>
	);
}
