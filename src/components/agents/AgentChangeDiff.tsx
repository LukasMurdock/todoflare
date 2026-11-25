import { CheckSquare, Square } from "lucide-react";
import type { AgentChangeDiff, AgentDiffItem } from "@/lib/api/agent-contract";
import { textChange } from "@/lib/agents/text-change";
import { cn } from "@/lib/utils";

function Marker({ item }: { item: AgentDiffItem }) {
	if (item.style === "todo") {
		const Icon = item.checked ? CheckSquare : Square;
		return <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-label={item.checked ? "checked" : "unchecked"} />;
	}
	if (item.style === "bullet") {return <span className="w-3.5 shrink-0 text-center" aria-hidden>•</span>;}
	if (item.style === "numbered") {return <span className="w-3.5 shrink-0 text-center" aria-hidden>1.</span>;}
	return null;
}

type Sign = "added" | "removed" | "changed";

const SIGN_GLYPH: Record<Sign, string> = { added: "+", removed: "−", changed: "~" };
const SIGN_CLASS: Record<Sign, string> = {
	added: "text-emerald-600 dark:text-emerald-400",
	removed: "text-red-600 dark:text-red-400",
	changed: "text-muted-foreground",
};
const STRIP_CLASS: Record<Sign, string> = {
	added: "bg-emerald-500/[0.08]",
	removed: "bg-red-500/[0.06]",
	changed: "",
};

/** One diff row: a +/−/~ gutter, then the item indented to its depth. */
function Row({ sign, depth, className, children, ...props }: { sign: Sign; depth: number; className?: string; children: React.ReactNode; "data-diff"?: string }) {
	return (
		<div className={cn("flex items-start px-1.5 py-0.5", STRIP_CLASS[sign], className)} {...props}>
			<span aria-hidden className={cn("w-3.5 shrink-0 font-mono font-semibold select-none", SIGN_CLASS[sign])}>
				{SIGN_GLYPH[sign]}
			</span>
			<div className="flex min-w-0 flex-1 items-start gap-1.5" style={{ paddingLeft: `${depth * 0.75}rem` }}>
				{children}
			</div>
		</div>
	);
}

function Line({ item, sign, className, children }: { item: AgentDiffItem; sign: Sign; className?: string; children?: React.ReactNode }) {
	return (
		<Row sign={sign} depth={item.depth} className={cn(item.style.startsWith("heading") && "font-semibold", className)}>
			<Marker item={item} />
			<span className="min-w-0 break-words">{children ?? (item.text || <em className="text-muted-foreground">empty line</em>)}</span>
		</Row>
	);
}

function Changed({ before, after }: { before: AgentDiffItem; after: AgentDiffItem }) {
	const markerChanged = before.style !== after.style || before.checked !== after.checked || before.depth !== after.depth;
	if (before.text === after.text) {
		// Only the checkbox, style or nesting changed: one line, old marker → new marker.
		return (
			<Row sign="changed" depth={after.depth} data-diff="changed">
				{markerChanged && (
					<>
						<span className="text-muted-foreground">
							<Marker item={before} />
						</span>
						<span className="text-muted-foreground" aria-label="became">
							→
						</span>
					</>
				)}
				<Marker item={after} />
				<span className={cn("min-w-0 break-words", after.style.startsWith("heading") && "font-semibold")}>{after.text}</span>
			</Row>
		);
	}
	const text = textChange(before.text, after.text);
	return (
		<div data-diff="changed">
			{markerChanged && (
				<Line item={before} sign="removed" className="text-muted-foreground line-through decoration-red-500/50">
					{before.text}
				</Line>
			)}
			<Line item={after} sign="changed">
				{text.prefix}
				{text.removed && <del className="rounded-sm bg-red-500/15 text-foreground decoration-red-500/60">{text.removed}</del>}
				{text.added && <ins className="rounded-sm bg-emerald-500/20 text-foreground no-underline">{text.added}</ins>}
				{text.suffix}
			</Line>
		</div>
	);
}

/** An agent change as items: what it added, removed and changed. */
export function AgentChangeDiffView({ diff, muted }: { diff: AgentChangeDiff; muted?: boolean }) {
	if (diff.entries.length === 0) {return null;}
	return (
		<div
			className={cn("overflow-hidden rounded-md border border-border/60 bg-muted/20 py-0.5 text-xs leading-5 text-foreground", muted && "opacity-60")}
			data-testid="agent-change-diff"
		>
			{diff.entries.map((entry, index) =>
				entry.kind === "added" ? (
					<Line key={index} item={entry.item} sign="added">
						<span className="sr-only">Added: </span>
						{entry.item.text || <em className="text-muted-foreground">empty line</em>}
					</Line>
				) : entry.kind === "removed" ? (
					<Line key={index} item={entry.item} sign="removed" className="line-through decoration-red-500/50">
						<span className="sr-only">Removed: </span>
						{entry.item.text || <em className="text-muted-foreground">empty line</em>}
					</Line>
				) : (
					<Changed key={index} before={entry.before} after={entry.after} />
				),
			)}
			{diff.omitted > 0 && <p className="px-1.5 py-0.5 pl-5 text-muted-foreground">and {diff.omitted} more</p>}
		</div>
	);
}
