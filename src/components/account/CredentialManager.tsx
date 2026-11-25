import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound, LogOut, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { accountCredentials } from '@/lib/auth-client';
import type { AccountCredentials, ListedPasskey } from '@/lib/auth-client';
import { useRecentSignIn } from "@/hooks/use-recent-sign-in";
import { ConfirmSignIn } from "./ConfirmSignIn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface CredentialManagerProps {
	accountId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CredentialManager({ accountId, open, onOpenChange }: CredentialManagerProps) {
	const [passkeys, setPasskeys] = useState<Array<ListedPasskey>>([]);
	const [name, setName] = useState("");
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const credentials = useMemo(() => (accountId ? accountCredentials(accountId) : null), [accountId]);
	const recent = useRecentSignIn(accountId);
	const { cancel } = recent;
	// While a refused change waits for confirmation, nothing else may change.
	const locked = busy || recent.pending;

	const refresh = useCallback((on: AccountCredentials) => on.listPasskeys().then(
		setPasskeys,
		(error: unknown) => setError(error instanceof Error && error.message ? error.message : "Unable to load passkeys"),
	), []);

	useEffect(() => {
		if (open && credentials) {void refresh(credentials);}
	}, [open, credentials, refresh]);

	// A kept change belongs to one opening of the dialog.
	useEffect(() => {
		cancel();
	}, [open, cancel]);

	const run = async (fallback: string, action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await action();
		} catch (error_) {
			setError(error_ instanceof Error && error_.message ? error_.message : fallback);
		} finally {
			setBusy(false);
		}
	};

	const change = (fallback: string, action: (on: AccountCredentials) => Promise<void>) => {
		if (!credentials) {return;}
		const on = credentials;
		return run(fallback, () => recent.attempt(() => action(on), fallback));
	};

	const add = () => change("Passkey registration failed", async (on) => {
		await on.addPasskey(name.trim() || `Passkey ${passkeys.length + 1}`);
		setName("");
		await refresh(on);
	});

	const remove = (passkey: ListedPasskey) => change("Passkey removal failed", async (on) => {
		await on.deletePasskey(passkey);
		await refresh(on);
		setNotice("Passkey removed. If a device was lost, also sign out other sessions.");
	});

	const createRecoveryCode = () => change("Recovery code creation failed", async (on) => {
		setRecoveryCode(await on.generateRecoveryCode());
	});

	const signOutOtherSessions = () => change("Unable to sign out other sessions", async (on) => {
		await on.revokeOtherSessions();
		setNotice("Other sessions are signed out.");
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-[28rem]"
				onOpenAutoFocus={(event) => {
					if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
						event.preventDefault();
					}
				}}
			>
				<DialogHeader className="text-left">
					<DialogTitle>Passkeys and recovery</DialogTitle>
					<DialogDescription>
						Keep at least two passkeys, or store a recovery code somewhere safe.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col divide-y divide-border/60">
					<section className="flex flex-col gap-3 pb-4">
						<SectionHeading title="Passkeys" detail={passkeys.length > 0 ? String(passkeys.length) : undefined} />
						{passkeys.length > 0 && (
							<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/70">
								{passkeys.map((passkey) => (
									<li key={passkey.id} className="flex items-center gap-3 px-3 py-2">
										<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
											<KeyRound className="size-3.5 stroke-[1.75]" />
										</span>
										<span className="min-w-0 flex-1 truncate text-sm">{passkey.name || "Passkey"}</span>
										<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={locked} onClick={() => void remove(passkey)}>
											Remove
										</Button>
									</li>
								))}
							</ul>
						)}
						{passkeys.length < 2 && (
							<p className="flex items-start gap-2 rounded-md border-l-2 border-amber-500 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
								<ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
								Add a backup passkey on another device so you can’t be locked out.
							</p>
						)}
						<div className="flex gap-2">
							<Input
								value={name}
								disabled={locked}
								onChange={(event) => setName(event.target.value)}
								placeholder="Passkey name"
								aria-label="Passkey name"
								className="h-8"
							/>
							<Button size="sm" disabled={locked} onClick={() => void add()}>
								<Plus />
								Add passkey
							</Button>
						</div>
					</section>
					<section className="flex flex-col gap-3 py-4">
						<SectionHeading title="Recovery code" />
						<p className="text-xs leading-5 text-muted-foreground">
							A recovery code signs you in if every passkey is lost. Creating a new one replaces the old.
						</p>
						<Button variant="outline" size="sm" className="self-start" disabled={locked} onClick={() => void createRecoveryCode()}>
							<RefreshCw />
							Create or rotate recovery code
						</Button>
						{recoveryCode && <RecoveryCodeCard code={recoveryCode} message="Save this now. It is shown only once." />}
					</section>
					<section className="flex flex-col gap-3 pt-4">
						<SectionHeading title="Sessions" />
						<p className="text-xs leading-5 text-muted-foreground">
							Sign out every other browser that uses this account, for example after losing a device.
						</p>
						<Button variant="outline" size="sm" className="self-start" disabled={locked} onClick={() => void signOutOtherSessions()}>
							<LogOut />
							Sign out other sessions
						</Button>
					</section>
				</div>
				{recent.pending && (
					<ConfirmSignIn busy={busy} onConfirm={() => void run(recent.fallback ?? "Passkey confirmation failed", recent.confirm)} onCancel={recent.cancel} />
				)}
				{notice && <p className="text-[13px] text-muted-foreground">{notice}</p>}
				{error && (
					<p className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-400">
						<ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
						<span>{error}</span>
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

function SectionHeading({ title, detail }: { title: string; detail?: string }) {
	return (
		<h3 className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
			{title}
			{detail && <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums">{detail}</span>}
		</h3>
	);
}

/** The app icon as a 40px tile, for dialog and page headers. */
export function AppIconTile({ className }: { className?: string }) {
	return (
		<img
			src="/todoflare-icon.png"
			alt=""
			width={40}
			height={40}
			className={cn("size-10 shrink-0 rounded-[10px] shadow-sm ring-1 ring-black/5 dark:ring-white/10", className)}
		/>
	);
}

/** A freshly issued recovery code: shown once, with a copy button. */
export function RecoveryCodeCard({ code, message }: { code: string; message: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard access can be refused; the code stays selectable.
		}
	};
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-dashed border-amber-500/60 bg-amber-500/[0.06] p-3">
			<div className="flex items-center gap-2">
				<span className="rounded-full bg-amber-500/15 px-2 py-px text-[10.5px] font-medium tracking-[0.04em] text-amber-800 uppercase dark:text-amber-300">
					Shown once
				</span>
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto h-6 gap-1 px-1.5 text-xs"
					onClick={() => void copy()}
					aria-label={copied ? "Copied recovery code" : "Copy recovery code"}
				>
					{copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<p className="text-xs">{message}</p>
			<code className="block rounded-md bg-background px-2.5 py-2 font-mono text-xs leading-5 break-all select-all">{code}</code>
		</div>
	);
}
