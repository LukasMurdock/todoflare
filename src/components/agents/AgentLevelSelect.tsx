import { AGENT_GRANT_LEVELS } from '@/lib/api/agent-contract';
import type { AgentGrantLevel } from '@/lib/api/agent-contract';
import { AGENT_LEVEL_DESCRIPTIONS, AGENT_LEVEL_LABELS } from "@/lib/agents/agents-api";
import { NativeSelect } from "@/components/ui/native-select";

interface AgentLevelSelectProps {
	value: AgentGrantLevel | null;
	onChange: (level: AgentGrantLevel | null) => void;
	disabled?: boolean;
	/** Offer "No access", which removes the grant. */
	allowNone?: boolean;
	label: string;
	className?: string;
}

/** A dot marks the levels that let an agent write. */
export function levelDot(level: AgentGrantLevel | "none" | null | undefined): string | false {
	return level === "append" || level === "edit" ? "bg-brand" : false;
}

export function AgentLevelSelect({ value, onChange, disabled, allowNone = true, label, className }: AgentLevelSelectProps) {
	return (
		<NativeSelect
			aria-label={label}
			title={value ? AGENT_LEVEL_DESCRIPTIONS[value] : "No access"}
			wrapperClassName={className ?? "w-[7.25rem]"}
			dot={levelDot(value)}
			className={value ? "w-full" : "w-full text-muted-foreground"}
			value={value ?? ""}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value === "" ? null : (AGENT_GRANT_LEVELS.find((level) => level === event.target.value) ?? null))}
		>
			{allowNone && <option value="">No access</option>}
			{AGENT_GRANT_LEVELS.map((level) => (
				<option key={level} value={level}>
					{AGENT_LEVEL_LABELS[level]}
				</option>
			))}
		</NativeSelect>
	);
}
