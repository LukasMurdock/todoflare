import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, BadgeCheck, Bot, Fingerprint, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSyncContext } from "@/contexts/sync-context";
import { agentsApi } from "@/lib/agents/agents-api";
import type { AgentGrantLevel, GrantableColumn } from "@/lib/api/agent-contract";
import { API_ROUTES } from "@/lib/api/routes";
import { useRecentSignIn } from "@/hooks/use-recent-sign-in";
import { ConfirmSignIn } from "@/components/account/ConfirmSignIn";
import { AppIconTile } from "@/components/account/CredentialManager";
import { NativeSelect } from "@/components/ui/native-select";
import { AgentColumnPicker } from "./AgentColumnPicker";

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
		<main className="flex min-h-dvh flex-col items-center justify-start gap-2.5 bg-[oklch(0.975_0_0)] p-3 pt-4 sm:justify-center sm:gap-3 sm:p-5 dark:bg-[oklch(0.11_0_0)]">
			<div className="w-full max-w-[26rem] space-y-3.5 rounded-2xl border border-border/70 bg-card p-4 text-card-foreground shadow-pop sm:space-y-4 sm:p-6 dark:shadow-none dark:ring-1 dark:ring-white/[0.08]">
				{children}
			</div>
			<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<img src="/todoflare-icon.png" alt="" width={14} height={14} className="size-3.5 rounded-[3px]" />
				Todoflare
			</p>
		</main>
	);
}

/** A short state on its own: an icon tile, a line or two, and an optional action. */
function Notice({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-3 py-2 text-center">
			{icon ?? <AppIconTile />}
			{children}
		</div>
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
		const values: Record<string, string> = {};
		for (const key of AUTHORIZATION_PARAMS) {
			const value = search.get(key);
			if (value !== null) { values[key] = value; }
		}
		return values;
	}, []);
	const [page, setPage] = useState<PageState>(() => (window.top !== window.self ? { kind: "framed" } : { kind: "loading" }));
	const [columns, setColumns] = useState<Array<GrantableColumn> | null>(null);
	const [levels, setLevels] = useState<Record<string, AgentGrantLevel>>({});
	const [name, setName] = useState("");
	const [expiresInDays, setExpiresInDays] = useState(30);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const signedIn = !!accountId && authenticationStatus === "authenticated";
	const recent = useRecentSignIn(signedIn ? accountId : null);
	// While a refused approval waits for confirmation, its choices are frozen.
	const locked = busy || recent.pending;

	useEffect(() => {
		if (page.kind !== "loading") {return;}
		void (async () => {
			const response = await fetch(`${API_ROUTES.describeAuthorization.path}?${new URLSearchParams(params)}`, { credentials: "same-origin" });
			const body = await response.json<({ ok: true } & DescribedClient) | { ok: false; display: string; redirectTo?: string }>().catch(() => null);
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

	const leave = (to: string) => {
		setPage({ kind: "leaving", to });
		window.location.assign(to);
	};

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (error_) {
			setError(error_ instanceof Error && error_.message ? error_.message : "Could not complete the request");
		} finally {
			setBusy(false);
		}
	};

	const decide = (decision: "approve" | "deny") => {
		if (!accountId) {return;}
		if (decision === "deny") {
			return run(async () => leave(await agentsApi.decideAuthorization(accountId, { decision, params })));
		}
		const grants = Object.entries(levels).map(([columnId, level]) => ({ columnId, level }));
		const body = { decision, params, name: name.trim() || "Agent", expiresInDays, grants } as const;
		// Approving mints a connection that outlives the session, so it may need a recent sign-in.
		return run(() => recent.attempt(async () => leave(await agentsApi.decideAuthorization(accountId, body)), "Could not complete the request"));
	};

	if (page.kind === "framed") {
		return (
			<Card>
				<Notice icon={<span className="flex size-10 items-center justify-center rounded-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400"><ShieldAlert className="size-5 stroke-[1.75]" /></span>}>
					<p className="text-[13px] leading-5">For your safety, this page cannot be shown inside another site. Open it in its own tab.</p>
				</Notice>
			</Card>
		);
	}
	if (page.kind === "loading" || (page.kind === "ready" && isLoading)) {
		return (
			<Card>
				<Notice>
					<p className="flex items-center gap-2 text-[13px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Loading…
					</p>
				</Notice>
			</Card>
		);
	}
	if (page.kind === "invalid") {
		const { redirectTo } = page;
		return (
			<Card>
				<Notice icon={<span className="flex size-10 items-center justify-center rounded-[10px] bg-red-500/10 text-red-600 dark:text-red-400"><ShieldAlert className="size-5 stroke-[1.75]" /></span>}>
					<h1 className="text-[17px] font-semibold tracking-[-0.01em]">This connection can’t continue</h1>
					<p className="text-[13px] leading-5 text-muted-foreground">{page.message}</p>
					{redirectTo && (
						<Button variant="outline" className="mt-1" onClick={() => window.location.assign(redirectTo)}>
							Return to the app
						</Button>
					)}
				</Notice>
			</Card>
		);
	}
	if (page.kind === "leaving") {
		return (
			<Card>
				<Notice>
					<p className="flex items-center gap-2 text-[13px]">
						<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
						Returning you to {new URL(page.to).host}…
					</p>
				</Notice>
			</Card>
		);
	}

	const { client, redirectHost, redirectIsLocalhost } = page.described;
	const chosen = Object.keys(levels).length;

	const microLabel = "text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground uppercase";

	return (
		<Card>
			<div className="flex flex-col items-center gap-3 text-center sm:gap-4">
				<div className="flex items-center gap-2.5" aria-hidden>
					<span className="flex size-10 items-center justify-center rounded-[10px] bg-muted text-foreground ring-1 ring-black/5 dark:ring-white/10">
						<Bot className="size-5 stroke-[1.75]" />
					</span>
					<ArrowLeftRight className="size-3.5 text-muted-foreground" />
					<AppIconTile />
				</div>
				<h1 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-balance" data-testid="consent-client-name">
					{client.name} wants to use Todoflare
				</h1>
			</div>

			<div className="space-y-2">
				<div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5">
					{client.verified && client.clientIdHost ? (
						<>
							<BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-brand" />
							<span>Published by {client.clientIdHost}</span>
						</>
					) : (
						<>
							<ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<span className="text-muted-foreground">This app registered itself; Todoflare has not verified who made it.</span>
						</>
					)}
				</div>
				<p className="text-xs leading-5 text-muted-foreground">
					After you decide, you’ll return to <strong className="font-mono font-medium text-foreground">{redirectHost}</strong>.
				</p>
				{redirectIsLocalhost && (
					<div className="flex gap-2 border-l-2 border-amber-500 bg-amber-500/10 py-2 pr-3 pl-2.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
						<ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
						<span>This app runs on your own computer. Only continue if you just started connecting it yourself.</span>
					</div>
				)}
			</div>

			{!signedIn ? (
				<div className="flex flex-col gap-2.5 border-t border-border/60 pt-5">
					<p className="text-[13px]">Sign in to choose what {client.name} can use.</p>
					<Button className="h-10 w-full" onClick={() => void loginWithPasskey()}>
						<Fingerprint className="stroke-[1.75]" />
						Sign in with a passkey
					</Button>
					{syncError && <p className="text-[13px] text-red-600 dark:text-red-400">{syncError}</p>}
					<p className="text-xs leading-5 text-muted-foreground">No account yet? Create one in Todoflare in another tab, then come back here.</p>
				</div>
			) : (
				<>
					<section className="flex flex-col gap-2 border-t border-border/60 pt-4">
						<h2 className="text-[13px] font-medium">Choose what it can use</h2>
						<p className="text-xs leading-5 text-muted-foreground">It can only use the columns you choose here, at the level you set. You can change this later in Todoflare under Agents.</p>
						<AgentColumnPicker columns={columns} levels={levels} onChange={setLevels} disabled={locked} />
					</section>
					<section className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5">
						<label htmlFor="consent-name" className={microLabel}>Name</label>
						<label htmlFor="consent-expiry" className={microLabel}>Expires after</label>
						<Input id="consent-name" aria-label="Name for this connection" className="h-8" value={name} maxLength={80} disabled={locked} onChange={(event) => setName(event.target.value)} />
						<NativeSelect
							id="consent-expiry"
							aria-label="Access lasts"
							wrapperClassName="w-28"
							className="w-full"
							value={expiresInDays}
							disabled={locked}
							onChange={(event) => setExpiresInDays(Number(event.target.value))}
						>
							{EXPIRY_CHOICES.map((days) => (
								<option key={days} value={days}>
									{days === 1 ? "1 day" : `${days} days`}
								</option>
							))}
						</NativeSelect>
					</section>
					{recent.pending && <ConfirmSignIn busy={busy} onConfirm={() => void run(recent.confirm)} onCancel={recent.cancel} />}
					{error && <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}
					<div className="flex flex-col-reverse gap-2 border-t border-border/60 pt-3.5 max-sm:sticky max-sm:bottom-0 max-sm:-mx-4 max-sm:-mb-4 max-sm:rounded-b-2xl max-sm:bg-card/95 max-sm:px-4 max-sm:py-2.5 max-sm:backdrop-blur-md sm:flex-row sm:justify-end sm:pt-4">
						<Button variant="ghost" disabled={locked} onClick={() => void decide("deny")}>
							Cancel
						</Button>
						<Button disabled={locked} className="sm:min-w-32" onClick={() => void decide("approve")}>
							{chosen === 0 ? "Connect without columns" : `Allow ${chosen} column${chosen === 1 ? "" : "s"}`}
						</Button>
					</div>
				</>
			)}
		</Card>
	);
}
