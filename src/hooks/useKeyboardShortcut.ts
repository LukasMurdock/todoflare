import { useEffect, useCallback } from "react";

const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.platform);

export type ModifierKey = "mod" | "shift" | "alt";

interface UseKeyboardShortcutOptions {
	key: string;
	modifiers?: ModifierKey[];
	onTrigger: () => void;
}

/**
 * Hook for registering global keyboard shortcuts.
 *
 * @param key - The key to listen for (e.g., "/", "e", "Enter")
 * @param modifiers - Array of modifier keys: "mod" (⌘/Ctrl), "shift", "alt"
 * @param onTrigger - Callback to invoke when shortcut is triggered
 */
export function useKeyboardShortcut({
	key,
	modifiers = [],
	onTrigger,
}: UseKeyboardShortcutOptions) {
	const handler = useCallback(
		(event: KeyboardEvent) => {
			// Check modifiers
			const modPressed = modifiers.includes("mod")
				? isMac
					? event.metaKey
					: event.ctrlKey
				: true;
			const shiftPressed = modifiers.includes("shift")
				? event.shiftKey
				: true;
			const altPressed = modifiers.includes("alt") ? event.altKey : true;

			// Ensure no extra modifiers are pressed if not specified
			const noExtraMod = modifiers.includes("mod")
				? true
				: !(isMac ? event.metaKey : event.ctrlKey);
			const noExtraShift = modifiers.includes("shift")
				? true
				: !event.shiftKey;
			const noExtraAlt = modifiers.includes("alt") ? true : !event.altKey;

			if (
				modPressed &&
				shiftPressed &&
				altPressed &&
				noExtraMod &&
				noExtraShift &&
				noExtraAlt &&
				event.key === key
			) {
				event.preventDefault();
				onTrigger();
			}
		},
		[key, modifiers, onTrigger]
	);

	useEffect(() => {
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [handler]);
}

/**
 * Returns the platform-appropriate modifier key symbol.
 */
export function getModifierSymbol(): string {
	return isMac ? "⌘" : "Ctrl";
}

/**
 * Returns whether the current platform is Mac.
 */
export function getIsMac(): boolean {
	return isMac;
}
