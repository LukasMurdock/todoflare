import { useEffect, useMemo, useState } from "react";
import { Bot, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSyncContext } from "@/contexts/sync-context";
import { agentsApi } from "@/lib/agents/agents-api";
import type { AgentGrantLevel, GrantableColumn } from "@/lib/api/agent-contract";
import { accountRequestHeaders } from "@/lib/account-request-headers";
import { API_ROUTES } from "@/lib/api/routes";
import { AgentLevelSelect } from "./AgentLevelSelect";

const AUTHORIZATION_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"] as const;

interface DescribedClient {
	client: { name: string; clientUri: string | null; verified: boolean; clientIdHost: string | null };
	redirectHost: string;
	redirectIsLocalhost: boolean;
}

type PageState =
	| { kind: "loading" }
	| { kind: "framed" }
	| { kind: "invalid"; message: string; redirectTo?: string }
	| { kind: "ready"; described: DescribedClient }
	| { kind: "leaving"; to: string };

const EXPIRY_CHOICES = [1, 7, 30, 90];

function Card({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-dvh items-start justify-center bg-background p-4 sm:items-center">
			<div className="w-full max-w-md space-y-4 rounded-lg border p-6 shadow-sm">{children}</div>
		</main>
	);
}

/**
 * The OAuth authorization endpoint. A person sees which app is asking, where
 * they will be sent back, and chooses the columns and levels it gets. Those
 * choices are the grants: there is no blanket access to approve.
 */
export function OAuthConsentPage() {
	const { accountId, authenticationStatus, isLoading, loginWithPasskey, error: syncError } = useSyncContext();
	const params = useMemo(() => {
		const search = new URLSearchParams(window.location.search);
		return Object.fromEntries(AUTHORIZATION_PARAMS.flatMap((key) => (search.has(key) ? [[key, search.get(key)!]] : []))) as Record<string, string>;
	}, []);
	const [page, setPage] = useState<PageState>(() => (window.top !== window.self ? { kind: "framed" } : { kind: "loading" }));
	const [columns, setColumns] = useState<GrantableColumn[] | null>(null);
	const [levels, setLevels] = useState<Record<string, AgentGrantLevel>>({});
	const [name, setName] = useState("");
	const [expiresInDays, setExpiresInDays] = useState(30);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const signedIn = !!accountId && authenticationStatus === "authenticated";

	useEffect(() => {
		if (page.kind !== "loading") return;
		void (async () => {
			const response = await fetch(`${API_ROUTES.describeAuthorization.path}?${new URLSearchParams(params)}`, { credentials: "same-origin" });
			const body = (await response.json().catch(() => null)) as ({ ok: true } & DescribedClient) | { ok: false; display: string; redirectTo?: string } | null;
			if (!body || !body.ok) {
				setPage({ kind: "invalid", message: body?.display ?? "This sign-in link is not valid.", redirectTo: body && !body.ok ? body.redirectTo : undefined });
				return;
			}
			setName(body.client.name);
			setPage({ kind: "ready", described: body });
		})();
	}, [page.kind, params]);

	useEffect(() => {
		if (page.kind === "ready" && signedIn && accountId && columns === null) {
			agentsApi.grantableColumns(accountId).then(setColumns, () => setColumns([]));
		}
	}, [page.kind, signedIn, accountId, columns]);

	const decide = async (decision: "approve" | "deny") => {
		if (!accountId) return;
		setBusy(true);
		setError(null);
		try {
			const grants = Object.entries(levels).map(([columnId, level]) => ({ columnId, level }));
			const response = await fetch(API_ROUTES.decideAuthorization.path, {
				method: API_ROUTES.decideAuthorization.method,
				credentials: "same-origin",
				headers: { ...accountRequestHeaders(accountId), "Content-Type": "application/json" },
				body: JSON.stringify(decision === "deny" ? { decision, params } : { decision, params, name: name.trim() || "Agent", expiresInDays, grants }),
			});
			const body = (await response.json().catch(() => null)) as { redirectTo?: string; display?: string } | null;
			if (!response.ok || !body?.redirectTo) throw new Error(body?.display ?? "Could not complete the request");
			setPage({ kind: "leaving", to: body.redirectTo });
			window.location.assign(body.redirectTo);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not complete the request");
			setBusy(false);
		}
	};

	if (page.kind === "framed") {
		return (
			<Card>
				<p className="text-sm">For your safety, this page cannot be shown inside another site. Open it in its own tab.</p>
			</Card>
		);
	}
	if (page.kind === "loading" || (page.kind === "ready" && isLoading)) {
		return (
			<Card>
				<p className="text-sm text-muted-foreground">Loading…</p>
			</Card>
		);
	}
	if (page.kind === "invalid") {
		return (
			<Card>
				<h1 className="text-lg font-semibold">This connection can’t continue</h1>
				<p className="text-sm">{page.message}</p>
				{page.redirectTo && (
					<Button variant="outline" onClick={() => window.location.assign(page.redirectTo!)}>
						Return to the app
					</Button>
				)}
			</Card>
		);
	}
	if (page.kind === "leaving") {
		return (
			<Card>
				<p className="text-sm">Returning you to {new URL(page.to).host}…</p>
			</Card>
		);
	}

	const { client, redirectHost, redirectIsLocalhost } = page.described;
	const chosen = Object.keys(levels).length;

	return (
		<Card>
			<div className="flex items-center gap-3">
				<div className="rounded-full bg-muted p-2">
					<Bot className="h-5 w-5" />
				</div>
				<div className="min-w-0">
					<h1 className="text-lg font-semibold" data-testid="consent-client-name">
						{client.name} wants to use Todoflare
					</h1>
					<p className="text-xs text-muted-foreground">
						{client.verified && client.clientIdHost ? `Published by ${client.clientIdHost}` : "This app registered itself; Todoflare has not verified who made it."}
					</p>
				</div>
			</div>

			<p className="text-sm">
				After you decide, you’ll return to <strong className="font-mono">{redirectHost}</strong>.
			</p>
			{redirectIsLocalhost && (
				<div className="flex gap-2 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
					<ShieldAlert className="h-4 w-4 shrink-0" />
					<span>This app runs on your own computer. Only continue if you just started connecting it yourself.</span>
				</div>
			)}

			{!signedIn ? (
				<div className="space-y-2 border-t pt-4">
					<p className="text-sm">Sign in to choose what {client.name} can use.</p>
					<Button onClick={() => void loginWithPasskey()}>Sign in with a passkey</Button>
					{syncError && <p className="text-sm text-destructive">{syncError}</p>}
					<p className="text-xs text-muted-foreground">No account yet? Create one in Todoflare in another tab, then come back here.</p>
				</div>
			) : (
				<>
					<section className="space-y-2 border-t pt-4">
						<h2 className="text-sm font-medium">Choose what it can use</h2>
						<p className="text-xs text-muted-foreground">It can only use columns you choose here, at the level you set. You can change this later.</p>
						{columns === null ? (
							<p className="text-sm text-muted-foreground">Loading your columns…</p>
						) : columns.length === 0 ? (
							<p className="text-sm text-muted-foreground">You have no columns yet.</p>
						) : (
							<ul className="max-h-64 space-y-2 overflow-y-auto">
								{columns.map((column) => (
									<li key={column.columnId} className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate text-sm">
											{column.title || "Untitled column"}
											{!column.owned && <span className="text-xs text-muted-foreground"> · shared with you</span>}
										</span>
										<AgentLevelSelect
											label={`Access to ${column.title || "untitled column"}`}
											value={levels[column.columnId] ?? null}
											onChange={(level) =>
												setLevels((current) => {
													const next = { ...current };
													if (level) next[column.columnId] = level;
													else delete next[column.columnId];
													return next;
												})
											}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
					<section className="flex gap-2 border-t pt-4">
						<Input aria-label="Name for this connection" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
						<select
							aria-label="Access lasts"
							className="h-9 rounded-md border border-input bg-background px-2 text-sm"
							value={expiresInDays}
							onChange={(event) => setExpiresInDays(Number(event.target.value))}
						>
							{EXPIRY_CHOICES.map((days) => (
								<option key={days} value={days}>
									{days === 1 ? "1 day" : `${days} days`}
								</option>
							))}
						</select>
					</section>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button variant="outline" disabled={busy} onClick={() => decide("deny")}>
							Cancel
						</Button>
						<Button disabled={busy} onClick={() => decide("approve")}>
							{chosen === 0 ? "Connect without columns" : `Allow ${chosen} column${chosen === 1 ? "" : "s"}`}
						</Button>
					</div>
				</>
			)}
		</Card>
	);
}
