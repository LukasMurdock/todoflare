import { AGENT_GRANT_LEVELS, type AgentGrantLevel } from "@/lib/api/agent-contract";
import { AGENT_LEVEL_DESCRIPTIONS, AGENT_LEVEL_LABELS } from "@/lib/agents/agents-api";
import { cn } from "@/lib/utils";

interface AgentLevelSelectProps {
	value: AgentGrantLevel | null;
	onChange(level: AgentGrantLevel | null): void;
	disabled?: boolean;
	/** Offer "No access", which removes the grant. */
	allowNone?: boolean;
	label: string;
	className?: string;
}

export function AgentLevelSelect({ value, onChange, disabled, allowNone = true, label, className }: AgentLevelSelectProps) {
	return (
		<select
			aria-label={label}
			title={value ? AGENT_LEVEL_DESCRIPTIONS[value] : "No access"}
			className={cn(
				"h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
				className,
			)}
			value={value ?? ""}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value === "" ? null : (event.target.value as AgentGrantLevel))}
		>
			{allowNone && <option value="">No access</option>}
			{AGENT_GRANT_LEVELS.map((level) => (
				<option key={level} value={level}>
					{AGENT_LEVEL_LABELS[level]}
				</option>
			))}
		</select>
	);
}
