import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refreshAgentConnections, removeAgentConnection, replaceAgentConnection, useAgentConnections } from "@/hooks/useAgentConnections";
import { agentsApi, AGENT_LEVEL_DESCRIPTIONS, mcpEndpointUrl } from "@/lib/agents/agents-api";
import type { AgentConnection, AgentGrantLevel, GrantableColumn } from "@/lib/api/agent-contract";
import { AgentLevelSelect } from "./AgentLevelSelect";

interface AgentsDialogProps {
	accountId: string;
	open: boolean;
	onOpenChange(open: boolean): void;
}

const EXPIRY_CHOICES = [
	{ days: 1, label: "1 day" },
	{ days: 7, label: "7 days" },
	{ days: 30, label: "30 days" },
	{ days: 90, label: "90 days" },
];

function relative(timestamp: number | null, now: number): string {
	if (timestamp === null) return "never";
	const minutes = Math.round((timestamp - now) / 60_000);
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 48) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

function CopyField({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2">
			<code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{value}</code>
			<Button
				variant="outline"
				size="icon-sm"
				aria-label={`Copy ${label}`}
				onClick={async () => {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
			</Button>
		</div>
	);
}

/** Everything about the account's agents: connecting new ones, their column grants, and revocation. */
export function AgentsDialog({ accountId, open, onOpenChange }: AgentsDialogProps) {
	const { state } = useAgentConnections(accountId, open);
	const [columns, setColumns] = useState<GrantableColumn[] | null>(null);
	const [name, setName] = useState("Claude Code");
	const [expiresInDays, setExpiresInDays] = useState(30);
	const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setCreated(null);
		setError(null);
		void refreshAgentConnections(accountId);
		agentsApi.grantableColumns(accountId).then(setColumns, () => setColumns([]));
	}, [open, accountId]);

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	};

	const create = () =>
		run(async () => {
			const result = await agentsApi.create(accountId, name.trim() || "Agent", expiresInDays);
			replaceAgentConnection(accountId, result.agent);
			setCreated({ name: result.agent.name, token: result.token });
		});

	const setLevel = (agent: AgentConnection, columnId: string, level: AgentGrantLevel | null) =>
		run(async () => {
			const updated = level ? await agentsApi.setGrant(accountId, agent.id, columnId, level) : await agentsApi.removeGrant(accountId, agent.id, columnId);
			replaceAgentConnection(accountId, updated);
		});

	const revoke = (agent: AgentConnection) =>
		run(async () => {
			setConfirming(null);
			await agentsApi.revoke(accountId, agent.id);
			removeAgentConnection(accountId, agent.id);
			toast.success(`Disconnected ${agent.name}`);
		});

	const titleOf = (columnId: string) => columns?.find((column) => column.columnId === columnId)?.title || "Untitled column";
	const endpoint = mcpEndpointUrl();
	const now = Date.now();

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>Agents</DialogTitle>
					<DialogDescription>
						Let AI agents like Claude work with columns you choose. An agent acts as you, only on those columns, at the level you set.
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-5 overflow-y-auto">
					{state.status === "disabled" ? (
						<p className="text-sm text-muted-foreground">Agent access is not available on this server yet.</p>
					) : (
						<>
							<section className="space-y-2">
								<h3 className="text-sm font-medium">Connect Claude.ai or another app</h3>
								<p className="text-xs text-muted-foreground">
									Add this address as a custom connector. You will be asked here which columns it may use.
								</p>
								<CopyField value={endpoint} label="connector address" />
							</section>

							<section className="space-y-2 border-t pt-4">
								<h3 className="text-sm font-medium">Connect with a token</h3>
								<p className="text-xs text-muted-foreground">For Claude Code, scripts and other tools that accept a bearer token.</p>
								<div className="flex gap-2">
									<Input aria-label="Agent name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Agent name" />
									<select
										aria-label="Token lifetime"
										className="h-9 rounded-md border border-input bg-background px-2 text-sm"
										value={expiresInDays}
										onChange={(event) => setExpiresInDays(Number(event.target.value))}
									>
										{EXPIRY_CHOICES.map((choice) => (
											<option key={choice.days} value={choice.days}>
												{choice.label}
											</option>
										))}
									</select>
									<Button disabled={busy} onClick={create}>
										Create token
									</Button>
								</div>
								{created && (
									<div className="space-y-2 rounded border border-amber-500/50 bg-amber-500/10 p-3" data-testid="agent-token">
										<p className="text-xs">
											Token for {created.name}. Save it now: it is shown only once. Then choose its columns below.
										</p>
										<CopyField value={created.token} label="token" />
										<p className="text-xs text-muted-foreground">For Claude Code:</p>
										<CopyField
											value={`claude mcp add --transport http todoflare ${endpoint} --header "Authorization: Bearer ${created.token}"`}
											label="Claude Code command"
										/>
									</div>
								)}
							</section>

							<section className="space-y-3 border-t pt-4">
								<h3 className="text-sm font-medium">Connected agents</h3>
								{state.status === "loading" || state.status === "idle" ? (
									<p className="text-sm text-muted-foreground">Loading…</p>
								) : state.status === "error" ? (
									<p className="text-sm text-destructive">{state.message}</p>
								) : state.agents.length === 0 ? (
									<p className="text-sm text-muted-foreground">No agents connected.</p>
								) : (
									state.agents.map((agent) => {
										const grantable = (columns ?? []).filter((column) => !agent.grants.some((grant) => grant.columnId === column.columnId));
										return (
											<div key={agent.id} className="space-y-2 rounded border p-3" data-testid="agent-connection">
												<div className="flex items-start justify-between gap-3">
													<div className="min-w-0">
														<p className="truncate text-sm font-medium">{agent.name}</p>
														<p className="text-xs text-muted-foreground">
															{agent.clientId ? "Connected with sign-in" : "Token"} · used {relative(agent.lastUsedAt, now)} · expires {relative(agent.expiresAt, now)}
														</p>
													</div>
													{confirming === agent.id ? (
														<div className="flex shrink-0 gap-1">
															<Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setConfirming(null)}>
																Keep
															</Button>
															<Button variant="destructive" size="sm" className="h-7 px-2" disabled={busy} onClick={() => revoke(agent)}>
																Disconnect now
															</Button>
														</div>
													) : (
														<Button
															variant="outline"
															size="sm"
															className="h-7 shrink-0 px-2 text-destructive hover:text-destructive"
															disabled={busy}
															onClick={() => setConfirming(agent.id)}
														>
															Disconnect
														</Button>
													)}
												</div>
												{agent.grants.length === 0 && <p className="text-xs text-muted-foreground">No columns yet: this agent can do nothing.</p>}
												{agent.grants.map((grant) => (
													<div key={grant.columnId} className="flex items-center justify-between gap-2">
														<span className="min-w-0 truncate text-sm">{titleOf(grant.columnId)}</span>
														<AgentLevelSelect
															label={`${agent.name} access to ${titleOf(grant.columnId)}`}
															value={grant.level}
															disabled={busy}
															onChange={(level) => setLevel(agent, grant.columnId, level)}
														/>
													</div>
												))}
												{grantable.length > 0 && (
													<select
														aria-label={`Give ${agent.name} a column`}
														className="h-8 w-full rounded-md border border-dashed border-input bg-background px-2 text-sm text-muted-foreground"
														value=""
														disabled={busy}
														onChange={(event) => event.target.value && setLevel(agent, event.target.value, "read")}
													>
														<option value="">Give access to a column…</option>
														{grantable.map((column) => (
															<option key={column.columnId} value={column.columnId}>
																{column.title || "Untitled column"}
																{column.owned ? "" : " (shared with you)"}
															</option>
														))}
													</select>
												)}
											</div>
										);
									})
								)}
							</section>

							<details className="border-t pt-4 text-xs text-muted-foreground">
								<summary className="cursor-pointer">What each level allows</summary>
								<ul className="mt-2 list-disc space-y-1 pl-5">
									{Object.entries(AGENT_LEVEL_DESCRIPTIONS).map(([level, description]) => (
										<li key={level}>{description}.</li>
									))}
									<li>Agents never share columns, change links, delete columns or manage other agents.</li>
								</ul>
							</details>
						</>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
