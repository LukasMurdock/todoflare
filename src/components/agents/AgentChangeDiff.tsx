import { CheckSquare, Square } from "lucide-react";
import type { AgentChangeDiff, AgentDiffItem } from "@/lib/api/agent-contract";
import { textChange } from "@/lib/agents/text-change";
import { cn } from "@/lib/utils";

function Marker({ item }: { item: AgentDiffItem }) {
	if (item.style === "todo") {
		const Icon = item.checked ? CheckSquare : Square;
		return <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-label={item.checked ? "checked" : "unchecked"} />;
	}
	if (item.style === "bullet") return <span className="w-3.5 shrink-0 text-center" aria-hidden>•</span>;
	if (item.style === "numbered") return <span className="w-3.5 shrink-0 text-center" aria-hidden>1.</span>;
	return null;
}

function Line({ item, className, children }: { item: AgentDiffItem; className?: string; children?: React.ReactNode }) {
	return (
		<div className={cn("flex items-start gap-1.5", item.style.startsWith("heading") && "font-semibold", className)} style={{ paddingLeft: `${item.depth * 0.75}rem` }}>
			<Marker item={item} />
			<span className="min-w-0 break-words">{children ?? (item.text || <em className="text-muted-foreground">empty line</em>)}</span>
		</div>
	);
}

function Changed({ before, after }: { before: AgentDiffItem; after: AgentDiffItem }) {
	const markerChanged = before.style !== after.style || before.checked !== after.checked || before.depth !== after.depth;
	if (before.text === after.text) {
		// Only the checkbox, style or nesting changed: one line, old marker → new marker.
		return (
			<div className="flex items-start gap-1.5" data-diff="changed" style={{ paddingLeft: `${after.depth * 0.75}rem` }}>
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
			</div>
		);
	}
	const text = textChange(before.text, after.text);
	return (
		<div className="space-y-0.5" data-diff="changed">
			{markerChanged && (
				<Line item={before} className="text-muted-foreground line-through decoration-red-500/60">
					{before.text}
				</Line>
			)}
			<Line item={after}>
				{text.prefix}
				{text.removed && <del className="rounded-sm bg-red-500/15 text-red-700 dark:text-red-300">{text.removed}</del>}
				{text.added && <ins className="rounded-sm bg-green-500/15 text-green-700 no-underline dark:text-green-300">{text.added}</ins>}
				{text.suffix}
			</Line>
		</div>
	);
}

/** An agent change as items: what it added, removed and changed. */
export function AgentChangeDiffView({ diff, muted }: { diff: AgentChangeDiff; muted?: boolean }) {
	if (diff.entries.length === 0) return null;
	return (
		<div className={cn("space-y-1 rounded bg-muted/50 p-1.5 text-xs", muted && "opacity-60")} data-testid="agent-change-diff">
			{diff.entries.map((entry, index) =>
				entry.kind === "added" ? (
					<Line key={index} item={entry.item} className="text-green-700 dark:text-green-300">
						<span className="sr-only">Added: </span>
						{entry.item.text || <em>empty line</em>}
					</Line>
				) : entry.kind === "removed" ? (
					<Line key={index} item={entry.item} className="text-red-700 line-through dark:text-red-300">
						<span className="sr-only">Removed: </span>
						{entry.item.text || <em>empty line</em>}
					</Line>
				) : (
					<Changed key={index} before={entry.before} after={entry.after} />
				),
			)}
			{diff.omitted > 0 && <p className="text-muted-foreground">and {diff.omitted} more</p>}
		</div>
	);
}
