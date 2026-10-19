import { useEffect, useState } from "react";
import { ArrowLeft, Bot, Check, ChevronRight, Copy, ExternalLink, Globe, KeyRound, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refreshAgentConnections, removeAgentConnection, replaceAgentConnection, useAgentConnections } from "@/hooks/useAgentConnections";
import { agentsApi, mcpEndpointUrl } from "@/lib/agents/agents-api";
import type { AgentConnection, AgentGrantLevel, GrantableColumn } from "@/lib/api/agent-contract";
import { AgentColumnPicker } from "./AgentColumnPicker";
import { AgentLevelSelect } from "./AgentLevelSelect";

interface AgentsDialogProps {
	accountId: string;
	open: boolean;
	onOpenChange(open: boolean): void;
}

/** The apps the dialog has instructions for. Token apps get a token; Claude.ai signs in itself. */
type AgentApp = "claude-code" | "claude-ai" | "other";

type View =
	| { kind: "home" }
	| { kind: "setup"; app: AgentApp }
	| { kind: "connected"; app: Exclude<AgentApp, "claude-ai">; agent: AgentConnection; token: string };

const APPS: Array<{ app: AgentApp; title: string; detail: string; icon: typeof Bot; defaultName: string }> = [
	{ app: "claude-code", title: "Claude Code", detail: "The coding agent in your terminal", icon: Terminal, defaultName: "Claude Code" },
	{ app: "claude-ai", title: "Claude.ai", detail: "Add Todoflare as a connector in Claude on the web", icon: Globe, defaultName: "Claude" },
	{ app: "other", title: "Another app or script", detail: "Anything that takes an MCP server address and a token", icon: KeyRound, defaultName: "My agent" },
];

const EXPIRY_CHOICES = [
	{ days: 1, label: "1 day" },
	{ days: 7, label: "7 days" },
	{ days: 30, label: "30 days" },
	{ days: 90, label: "90 days" },
];

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

function relative(timestamp: number | null, now: number): string {
	if (timestamp === null) return "never";
	const minutes = Math.round((timestamp - now) / 60_000);
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 48) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

/** The command that adds Todoflare to Claude Code for every folder, not only the current one. */
export function claudeCodeCommand(endpoint: string, token: string): string {
	return `claude mcp add --scope user --transport http todoflare ${endpoint} --header "Authorization: Bearer ${token}"`;
}

function CopyField({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2">
			<code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{value}</code>
			<Button
				variant="outline"
				size="sm"
				className="shrink-0"
				aria-label={`Copy ${label}`}
				onClick={async () => {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

/** One numbered instruction. */
function Step({ number, title, children }: { number: number; title: React.ReactNode; children?: React.ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{number}</span>
			<div className="min-w-0 flex-1 space-y-2 pt-0.5">
				<p className="text-sm font-medium">{title}</p>
				{children}
			</div>
		</li>
	);
}

function BackButton({ onClick }: { onClick(): void }) {
	return (
		<Button variant="ghost" size="sm" className="-ml-2 h-7 px-2" onClick={onClick}>
			<ArrowLeft className="h-3 w-3" />
			Back
		</Button>
	);
}

/** Everything about the account's agents: step-by-step connection for each app, their column grants, and revocation. */
export function AgentsDialog({ accountId, open, onOpenChange }: AgentsDialogProps) {
	const { state } = useAgentConnections(accountId, open);
	const [columns, setColumns] = useState<GrantableColumn[] | null>(null);
	const [view, setView] = useState<View>({ kind: "home" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setView({ kind: "home" });
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

	const go = (next: View) => {
		setError(null);
		setView(next);
	};

	const endpoint = mcpEndpointUrl();

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>Agents</DialogTitle>
					<DialogDescription>Let an AI agent like Claude read or edit the columns you choose, and nothing else.</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-5 overflow-y-auto">
					{state.status === "disabled" ? (
						<p className="text-sm text-muted-foreground">Agent access is not available on this server yet.</p>
					) : view.kind === "home" ? (
						<Home accountId={accountId} state={state} columns={columns} busy={busy} run={run} onChoose={(app) => go({ kind: "setup", app })} />
					) : view.kind === "setup" && view.app === "claude-ai" ? (
						<ClaudeAiSetup endpoint={endpoint} onBack={() => go({ kind: "home" })} />
					) : view.kind === "setup" ? (
						<TokenSetup
							key={view.app}
							app={view.app as Exclude<AgentApp, "claude-ai">}
							columns={columns}
							busy={busy}
							onBack={() => go({ kind: "home" })}
							onCreate={(name, expiresInDays, levels) =>
								run(async () => {
									const grants = Object.entries(levels).map(([columnId, level]) => ({ columnId, level }));
									const result = await agentsApi.create(accountId, name, expiresInDays, grants);
									replaceAgentConnection(accountId, result.agent);
									setView({ kind: "connected", app: view.app as Exclude<AgentApp, "claude-ai">, agent: result.agent, token: result.token });
								})
							}
						/>
					) : (
						<TokenConnected view={view} endpoint={endpoint} onDone={() => go({ kind: "home" })} />
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AppChoices({ onChoose }: { onChoose(app: AgentApp): void }) {
	return (
		<ul className="space-y-2">
			{APPS.map(({ app, title, detail, icon: Icon }) => (
				<li key={app}>
					<button
						type="button"
						className="flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted"
						onClick={() => onChoose(app)}
					>
						<Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1">
							<span className="block text-sm font-medium">{title}</span>
							<span className="block text-xs text-muted-foreground">{detail}</span>
						</span>
						<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
					</button>
				</li>
			))}
		</ul>
	);
}

function Home({
	accountId,
	state,
	columns,
	busy,
	run,
	onChoose,
}: {
	accountId: string;
	state: ReturnType<typeof useAgentConnections>["state"];
	columns: GrantableColumn[] | null;
	busy: boolean;
	run(action: () => Promise<void>): Promise<void>;
	onChoose(app: AgentApp): void;
}) {
	const [confirming, setConfirming] = useState<string | null>(null);
	const agents = state.status === "ready" ? state.agents : [];
	const now = Date.now();
	const titleOf = (columnId: string) => columns?.find((column) => column.columnId === columnId)?.title || "Untitled column";

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

	const choices = (
		<section className="space-y-2">
			<h3 className="text-sm font-medium">{agents.length === 0 ? "Which app do you want to connect?" : "Connect another app"}</h3>
			<AppChoices onChoose={onChoose} />
		</section>
	);

	return (
		<>
			{agents.length === 0 && choices}
			<section className={agents.length === 0 ? "space-y-3 border-t pt-4" : "space-y-3"}>
				<h3 className="text-sm font-medium">Connected agents</h3>
				{state.status === "loading" || state.status === "idle" ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : state.status === "error" ? (
					<p className="text-sm text-destructive">{state.message}</p>
				) : agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">No agents connected.</p>
				) : (
					agents.map((agent) => {
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
								{agent.grants.length === 0 && (
									<p className="rounded bg-amber-500/10 px-2 py-1 text-xs">It can’t see any columns yet. Add one below.</p>
								)}
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
										<option value="">+ Add a column…</option>
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
			{agents.length > 0 && <div className="border-t pt-4">{choices}</div>}
			<p className="border-t pt-4 text-xs text-muted-foreground">
				Agents act as you, only on the columns you give them. They can never share columns, change links, delete columns or connect other agents. Each column’s
				agent button shows what agents did there, with undo.
			</p>
		</>
	);
}

function TokenSetup({
	app,
	columns,
	busy,
	onBack,
	onCreate,
}: {
	app: Exclude<AgentApp, "claude-ai">;
	columns: GrantableColumn[] | null;
	busy: boolean;
	onBack(): void;
	onCreate(name: string, expiresInDays: number, levels: Record<string, AgentGrantLevel>): void;
}) {
	const { title, defaultName } = APPS.find((entry) => entry.app === app)!;
	const [levels, setLevels] = useState<Record<string, AgentGrantLevel>>({});
	const [name, setName] = useState(defaultName);
	const [expiresInDays, setExpiresInDays] = useState(30);
	const chosen = Object.keys(levels).length;

	return (
		<section className="space-y-4">
			<BackButton onClick={onBack} />
			<h3 className="text-base font-semibold">Connect {title}</h3>
			<ol className="space-y-5">
				<Step number={1} title="Choose which columns it can use">
					<AgentColumnPicker columns={columns} levels={levels} onChange={setLevels} disabled={busy} />
				</Step>
				<Step number={2} title="Name it and choose how long it lasts">
					<div className="flex gap-2">
						<Input aria-label="Agent name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Agent name" />
						<select
							aria-label="Access lasts"
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
					</div>
				</Step>
				<Step number={3} title={app === "claude-code" ? "Get the command for your terminal" : "Get the address and token"}>
					<Button disabled={busy || chosen === 0} onClick={() => onCreate(name.trim() || defaultName, expiresInDays, levels)}>
						{chosen === 0 ? "Choose a column first" : `Connect with ${chosen} column${chosen === 1 ? "" : "s"}`}
					</Button>
				</Step>
			</ol>
		</section>
	);
}

function TokenConnected({ view, endpoint, onDone }: { view: Extract<View, { kind: "connected" }>; endpoint: string; onDone(): void }) {
	const columnCount = view.agent.grants.length;
	return (
		<section className="space-y-4" data-testid="agent-token">
			<div className="flex items-center gap-2 rounded border border-green-600/40 bg-green-600/10 p-3 text-sm">
				<Check className="h-4 w-4 shrink-0 text-green-600" />
				<span>
					{view.agent.name} can use {columnCount} column{columnCount === 1 ? "" : "s"}. Finish setting it up below.
				</span>
			</div>
			<p className="text-xs text-amber-700 dark:text-amber-400">
				This contains a secret key and is shown only once. Don’t share it. If you lose it, disconnect this agent and connect again.
			</p>
			{view.app === "claude-code" ? (
				<ol className="space-y-5">
					<Step number={1} title="Copy this command">
						<CopyField value={claudeCodeCommand(endpoint, view.token)} label="Claude Code command" />
					</Step>
					<Step number={2} title="Paste it into your terminal and press Enter">
						<p className="text-xs text-muted-foreground">
							Connected Todoflare before? Run <code className="rounded bg-muted px-1">claude mcp remove --scope user todoflare</code> first.
						</p>
					</Step>
					<Step number={3} title={<>Start Claude Code with <code className="rounded bg-muted px-1">claude</code> and ask it to use Todoflare</>}>
						<p className="text-xs text-muted-foreground">For example: “List my Todoflare columns” or “Add ‘Buy stamps’ to my Errands column”.</p>
					</Step>
				</ol>
			) : (
				<ol className="space-y-5">
					<Step number={1} title="Give your app this MCP server address">
						<CopyField value={endpoint} label="server address" />
					</Step>
					<Step number={2} title="And this token, sent as a bearer token">
						<CopyField value={view.token} label="token" />
						<p className="text-xs text-muted-foreground">
							The app sends it as the header <code className="rounded bg-muted px-1">Authorization: Bearer &lt;token&gt;</code>.
						</p>
					</Step>
				</ol>
			)}
			<div className="flex justify-end">
				<Button onClick={onDone}>Done</Button>
			</div>
		</section>
	);
}

function ClaudeAiSetup({ endpoint, onBack }: { endpoint: string; onBack(): void }) {
	return (
		<section className="space-y-4">
			<BackButton onClick={onBack} />
			<h3 className="text-base font-semibold">Connect Claude.ai</h3>
			<ol className="space-y-5">
				<Step number={1} title="Copy this address">
					<CopyField value={endpoint} label="connector address" />
				</Step>
				<Step number={2} title="In Claude.ai, open Settings → Connectors and choose “Add custom connector”">
					<Button variant="outline" size="sm" asChild>
						<a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer">
							Open Claude.ai connectors
							<ExternalLink className="h-3 w-3" />
						</a>
					</Button>
				</Step>
				<Step number={3} title="Name it Todoflare, paste the address, and add it. Then click Connect" />
				<Step number={4} title="Claude sends you back to Todoflare. Choose the columns it can use and click Allow">
					<p className="text-xs text-muted-foreground">You’ll then see Claude under Connected agents here, and can change its columns any time.</p>
				</Step>
			</ol>
			<div className="flex justify-end">
				<Button variant="outline" onClick={onBack}>
					Done
				</Button>
			</div>
		</section>
	);
}
