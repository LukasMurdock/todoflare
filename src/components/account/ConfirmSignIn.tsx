import { Button } from "@/components/ui/button";

/**
 * Asks for a passkey before a change that needs a recent sign-in
 * (useRecentSignIn). Confirming retries the change as it was submitted, so
 * the surrounding form stays locked until the user confirms or cancels.
 */
export function ConfirmSignIn({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm(): void; onCancel(): void }) {
	return (
		<div className="space-y-2 rounded border p-3">
			<p className="text-sm">Confirm it's you with a passkey to make this change.</p>
			<div className="flex gap-2">
				<Button className="flex-1" disabled={busy} onClick={onConfirm}>
					Confirm with passkey
				</Button>
				<Button variant="ghost" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
