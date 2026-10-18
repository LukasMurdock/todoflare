"use client";

import * as React from "react";

/**
 * Whether Cmd (macOS) or Ctrl is held, owned by one board. Listeners exist only
 * while a board is mounted; nothing is registered at import time.
 */
class ModifierKeyStore {
	private pressed = false;
	private readonly listeners = new Set<() => void>();

	readonly getSnapshot = () => this.pressed;

	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	attach(target: Window): () => void {
		const set = (pressed: boolean) => {
			if (this.pressed === pressed) return;
			this.pressed = pressed;
			for (const listener of this.listeners) listener();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey) set(true);
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (!event.metaKey && !event.ctrlKey) set(false);
		};
		const onBlur = () => set(false);
		target.addEventListener("keydown", onKeyDown);
		target.addEventListener("keyup", onKeyUp);
		target.addEventListener("blur", onBlur);
		return () => {
			target.removeEventListener("keydown", onKeyDown);
			target.removeEventListener("keyup", onKeyUp);
			target.removeEventListener("blur", onBlur);
			set(false);
		};
	}
}

const ModifierKeyContext = React.createContext<ModifierKeyStore | null>(null);

export function ModifierKeyProvider({ children }: { children: React.ReactNode }) {
	const [store] = React.useState(() => new ModifierKeyStore());
	React.useEffect(() => store.attach(window), [store]);
	return <ModifierKeyContext.Provider value={store}>{children}</ModifierKeyContext.Provider>;
}

const neverPressed = () => false;
const noSubscription = () => () => {};

/** True while Cmd/Ctrl is held. Outside a board (and on the server) it is always false. */
export function useModifierKeyPressed(): boolean {
	const store = React.useContext(ModifierKeyContext);
	return React.useSyncExternalStore(
		store?.subscribe ?? noSubscription,
		store?.getSnapshot ?? neverPressed,
		neverPressed,
	);
}
