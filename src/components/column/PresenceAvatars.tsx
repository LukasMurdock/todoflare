import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePresence } from "@/hooks/usePresence";

interface PresenceAvatarsProps {
	columnId: string;
	maxVisible?: number;
}

export function PresenceAvatars({
	columnId,
	maxVisible = 3,
}: PresenceAvatarsProps) {
	const presence = usePresence(columnId);

	if (presence.length === 0) {
		return null;
	}

	const visible = presence.slice(0, maxVisible);
	const overflow = presence.length - maxVisible;

	const label = `${presence.length} ${presence.length === 1 ? "person" : "people"} viewing`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="flex items-center -space-x-1.5" aria-label={label} role="img">
					{visible.map((user) => (
						<span
							key={user.accountId}
							className="size-4 rounded-full ring-2 ring-background"
							style={{ backgroundColor: user.color }}
						/>
					))}
					{overflow > 0 && (
						<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-semibold text-muted-foreground tabular-nums ring-2 ring-background">
							+{overflow}
						</span>
					)}
				</div>
			</TooltipTrigger>
			<TooltipContent>
				<p>{label}</p>
			</TooltipContent>
		</Tooltip>
	);
}
