import { AGENT_GRANT_LEVELS } from '@/lib/api/agent-contract';
import type { AgentGrantLevel, GrantableColumn } from '@/lib/api/agent-contract';
import { AGENT_LEVEL_LABELS } from "@/lib/agents/agents-api";
import { Columns3 } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { AgentLevelSelect, levelDot } from "./AgentLevelSelect";

interface AgentColumnPickerProps {
	columns: Array<GrantableColumn> | null;
	levels: Record<string, AgentGrantLevel>;
	onChange: (levels: Record<string, AgentGrantLevel>) => void;
	disabled?: boolean;
}

/** The level every column shares, "none" when none has access, or null when they differ. */
function sharedLevel(columns: Array<GrantableColumn>, levels: Record<string, AgentGrantLevel>): AgentGrantLevel | "none" | null {
	const first = levels[columns[0].columnId] ?? "none";
	return columns.every((column) => (levels[column.columnId] ?? "none") === first) ? first : null;
}

/** Every column the person can reach, each with "No access" until they choose a level. */
export function AgentColumnPicker({ columns, levels, onChange, disabled }: AgentColumnPickerProps) {
	if (columns === null) {
		return (
			<div className="divide-y divide-border/60 rounded-lg border border-border/70" aria-busy>
				<p className="sr-only">Loading your columns…</p>
				{[0, 1, 2].map((row) => (
					<div key={row} className="flex items-center justify-between gap-3 px-3 py-2.5" aria-hidden>
						<span className="h-3 w-32 animate-pulse rounded bg-muted" />
						<span className="h-7 w-24 animate-pulse rounded-md bg-muted" />
					</div>
				))}
			</div>
		);
	}
	if (columns.length === 0) {
		return (
			<p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-[13px] text-muted-foreground">
				You have no columns yet. Add one to your board first.
			</p>
		);
	}
	const shared = columns.length > 1 ? sharedLevel(columns, levels) : null;
	return (
		<div className="flex flex-col gap-2">
			<div className="overflow-hidden rounded-lg border border-border/70">
				{columns.length > 1 && (
					<div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/40 py-1.5 pr-1.5 pl-3">
						<span className="flex items-center gap-2 text-[13px] font-medium">
							<Columns3 className="size-3.5 stroke-[1.75] text-muted-foreground" />
							All {columns.length} columns
						</span>
						<NativeSelect
							aria-label="Set access to all columns"
							value={shared ?? "mixed"}
							dot={levelDot(shared)}
							wrapperClassName="w-[7.25rem]"
							className="w-full bg-background"
							disabled={disabled}
							onChange={(event) => {
								if (event.target.value === "none") { onChange({}); return; }
								const level = AGENT_GRANT_LEVELS.find((item) => item === event.target.value);
								if (level) { onChange(Object.fromEntries(columns.map((column) => [column.columnId, level]))); }
							}}
						>
							<option value="mixed" disabled>
								Mixed
							</option>
							<option value="none">No access</option>
							{AGENT_GRANT_LEVELS.map((level) => (
								<option key={level} value={level}>
									{AGENT_LEVEL_LABELS[level]}
								</option>
							))}
						</NativeSelect>
					</div>
				)}
				<ul className="max-h-56 divide-y divide-border/60 overflow-y-auto">
					{columns.map((column) => {
						const granted = levels[column.columnId] !== undefined;
						return (
							<li key={column.columnId} className="relative flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-3">
								<span aria-hidden className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-brand transition-opacity", granted ? "opacity-100" : "opacity-0")} />
								<span className="min-w-0 truncate text-[13px]">
									{column.title || "Untitled column"}
									{!column.owned && <span className="text-xs text-muted-foreground"> · shared with you</span>}
								</span>
								<AgentLevelSelect
									label={`Access to ${column.title || "untitled column"}`}
									value={levels[column.columnId] ?? null}
									disabled={disabled}
									onChange={(level) => {
										const next = { ...levels };
										if (level) {next[column.columnId] = level;}
										else {delete next[column.columnId];}
										onChange(next);
									}}
								/>
							</li>
						);
					})}
				</ul>
			</div>
			<p className="text-xs leading-5 text-muted-foreground">
				<strong className="font-medium text-foreground">{AGENT_LEVEL_LABELS.read}</strong>: see the items. <strong className="font-medium text-foreground">{AGENT_LEVEL_LABELS.append}</strong>: also
				add new ones. <strong className="font-medium text-foreground">{AGENT_LEVEL_LABELS.edit}</strong>: also change, check off and delete them.
			</p>
		</div>
	);
}
