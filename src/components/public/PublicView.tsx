import { ArrowUpRight, Link2Off } from "lucide-react";
import { ColumnSnapshot } from "@todoflare/board";
import { usePublicColumnSync } from "@/hooks/usePublicColumnSync";

interface PublicViewProps {
	publicId: string;
}

// The header and the sheet share one measure, so their edges line up.
const CONTAINER = "mx-auto w-full max-w-[44rem] px-6";

function Header() {
	return (
		<header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur-md">
			<div className={`${CONTAINER} flex h-12 items-center justify-between gap-3`}>
				<div className="flex min-w-0 items-center gap-2">
					<img src="/todoflare-icon.png" alt="" width={20} height={20} className="size-5 rounded-[5px] ring-1 ring-black/5 dark:ring-white/10" />
					<span className="text-[14px] font-semibold tracking-[-0.01em]">Todoflare</span>
					<span className="rounded-full border border-border/70 bg-muted/60 px-2 py-px text-[11px] font-medium text-muted-foreground">
						Public View
					</span>
				</div>
				<a
					href="/"
					className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border/80 bg-background px-3 text-xs font-medium shadow-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none"
				>
					Create your own
					<ArrowUpRight className="size-3.5" />
				</a>
			</div>
		</header>
	);
}

export function PublicView({ publicId }: PublicViewProps) {
	const { value, isLoading, error } = usePublicColumnSync(publicId);

	if (error) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-[oklch(0.975_0_0)] p-4 dark:bg-[oklch(0.11_0_0)]">
				<div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card px-6 py-8 text-center shadow-pop dark:ring-1 dark:ring-white/[0.06]">
					<span className="flex size-10 items-center justify-center rounded-[10px] bg-muted text-muted-foreground">
						<Link2Off className="size-5 stroke-[1.75]" />
					</span>
					<h1 className="text-[17px] font-semibold tracking-[-0.01em]">Unable to load</h1>
					<p className="text-[13px] leading-5 text-muted-foreground">{error}</p>
					<a
						href="/"
						className="mt-1 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none"
					>
						Go to Todoflare
					</a>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-dvh flex-col bg-background sm:bg-[oklch(0.975_0_0)] dark:sm:bg-[oklch(0.11_0_0)]">
			<Header />
			<div className={`${CONTAINER} flex flex-1 flex-col max-sm:px-0`}>
				<main className="bg-background px-6 py-6 sm:my-10 sm:rounded-2xl sm:border sm:border-border/70 sm:bg-card sm:px-10 sm:py-8 sm:shadow-pop dark:sm:shadow-none dark:sm:ring-1 dark:sm:ring-white/[0.08] [&_[data-slate-editor]]:pb-0">
					{isLoading ? (
						<div className="space-y-3" aria-busy>
							<p className="sr-only">Loading...</p>
							<div className="h-6 w-1/2 animate-pulse rounded bg-muted" />
							<div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
							<div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
							<div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
						</div>
					) : (
						// The board's own static renderer, so headings and todos look as they do in the editor.
						<ColumnSnapshot value={value} />
					)}
				</main>
				<p className="mt-auto flex items-center justify-center gap-1.5 border-t border-border/50 bg-background/90 py-3 text-[11px] text-muted-foreground backdrop-blur-sm sm:mt-0 sm:border-0 sm:bg-transparent sm:pt-0 sm:pb-10 sm:backdrop-blur-none">
					<span aria-hidden className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.18)]" />
					Read-only · Updates live
				</p>
			</div>
		</div>
	);
}
