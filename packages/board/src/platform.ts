import { useSyncExternalStore } from "react";

/** Read at call time, never at import, so server rendering has no navigator dependency. */
export function isMacPlatform(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

const noSubscription = () => () => {};
const modifierSymbol = () => (isMacPlatform() ? "⌘" : "Ctrl");
const serverModifierSymbol = () => "Ctrl";

/**
 * The platform's modifier key symbol. Server rendering and hydration use
 * "Ctrl"; the client then switches to "⌘" on Apple platforms.
 */
export function useModifierSymbol(): string {
	return useSyncExternalStore(noSubscription, modifierSymbol, serverModifierSymbol);
}

/** Mod (⌘ on Apple platforms, Ctrl elsewhere) plus `key`, with no other modifiers. */
export function isModShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, key: string): boolean {
	const mac = isMacPlatform();
	const mod = mac ? event.metaKey : event.ctrlKey;
	const otherMod = mac ? event.ctrlKey : event.metaKey;
	return mod && !otherMod && !event.shiftKey && !event.altKey && event.key === key;
}
