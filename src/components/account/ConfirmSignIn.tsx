import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Asks for a passkey before a change that needs a recent sign-in
 * (useRecentSignIn). Confirming retries the change as it was submitted, so
 * the surrounding form stays locked until the user confirms or cancels.
 */
export function ConfirmSignIn({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm(): void; onCancel(): void }) {
	return (
		<div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
			<p className="flex items-start gap-2.5 text-[13px] leading-5">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-brand shadow-xs">
					<Fingerprint className="size-3.5 stroke-[1.75]" />
				</span>
				Confirm it's you with a passkey to make this change.
			</p>
			<div className="flex gap-2">
				<Button size="sm" className="flex-1" disabled={busy} onClick={onConfirm}>
					Confirm with passkey
				</Button>
				<Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
