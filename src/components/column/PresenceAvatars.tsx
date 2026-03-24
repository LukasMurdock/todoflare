import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePresence } from "@/hooks/usePresence";
import { cn } from "@/lib/utils";

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

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="flex items-center -space-x-1">
					{visible.map((user) => (
						<div
							key={user.accountId}
							className={cn(
								"size-3 rounded-full border border-background",
								"ring-1 ring-background",
							)}
							style={{ backgroundColor: user.color }}
						/>
					))}
					{overflow > 0 && (
						<span className="text-xs text-muted-foreground ml-1">
							+{overflow}
						</span>
					)}
				</div>
			</TooltipTrigger>
			<TooltipContent>
				<p>
					{presence.length} {presence.length === 1 ? "person" : "people"}{" "}
					viewing
				</p>
			</TooltipContent>
		</Tooltip>
	);
}
