import { AGENT_GRANT_LEVELS, type AgentGrantLevel, type GrantableColumn } from "@/lib/api/agent-contract";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/agents-api";
import { AgentLevelSelect } from "./AgentLevelSelect";

interface AgentColumnPickerProps {
	columns: GrantableColumn[] | null;
	levels: Record<string, AgentGrantLevel>;
	onChange(levels: Record<string, AgentGrantLevel>): void;
	disabled?: boolean;
}

/** The level every column shares, "none" when none has access, or null when they differ. */
function sharedLevel(columns: GrantableColumn[], levels: Record<string, AgentGrantLevel>): AgentGrantLevel | "none" | null {
	const first = levels[columns[0]!.columnId] ?? "none";
	return columns.every((column) => (levels[column.columnId] ?? "none") === first) ? first : null;
}

/** Every column the person can reach, each with "No access" until they choose a level. */
export function AgentColumnPicker({ columns, levels, onChange, disabled }: AgentColumnPickerProps) {
	if (columns === null) return <p className="text-sm text-muted-foreground">Loading your columns…</p>;
	if (columns.length === 0) return <p className="text-sm text-muted-foreground">You have no columns yet. Add one to your board first.</p>;
	return (
		<div className="space-y-2">
			{columns.length > 1 && (
				<div className="flex items-center justify-between gap-2 px-2">
					<span className="text-sm font-medium">All {columns.length} columns</span>
					<select
						aria-label="Set access to all columns"
						className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
						value={sharedLevel(columns, levels) ?? "mixed"}
						disabled={disabled}
						onChange={(event) => {
							const level = event.target.value;
							if (level === "mixed") return;
							onChange(level === "none" ? {} : Object.fromEntries(columns.map((column) => [column.columnId, level as AgentGrantLevel])));
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
					</select>
				</div>
			)}
			<ul className="max-h-56 space-y-1 overflow-y-auto rounded border p-2">
				{columns.map((column) => (
					<li key={column.columnId} className="flex items-center justify-between gap-2">
						<span className="min-w-0 truncate text-sm">
							{column.title || "Untitled column"}
							{!column.owned && <span className="text-xs text-muted-foreground"> · shared with you</span>}
						</span>
						<AgentLevelSelect
							label={`Access to ${column.title || "untitled column"}`}
							value={levels[column.columnId] ?? null}
							disabled={disabled}
							onChange={(level) => {
								const next = { ...levels };
								if (level) next[column.columnId] = level;
								else delete next[column.columnId];
								onChange(next);
							}}
						/>
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground">
				<strong className="font-medium">{AGENT_LEVEL_LABELS.read}</strong>: see the items. <strong className="font-medium">{AGENT_LEVEL_LABELS.append}</strong>: also
				add new ones. <strong className="font-medium">{AGENT_LEVEL_LABELS.edit}</strong>: also change, check off and delete them.
			</p>
		</div>
	);
}
