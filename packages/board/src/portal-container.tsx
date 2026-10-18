"use client";

import * as React from "react";

/**
 * Where the board's dialogs, popovers and menus portal to: the board's root
 * element, so they inherit its styles and never land in a host's document.body.
 * Outside a board, Radix's default (document.body) applies.
 */
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
	container,
	children,
}: {
	container: HTMLElement | null;
	children: React.ReactNode;
}) {
	return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

/** Pass as a Radix `Portal` container; undefined falls back to document.body. */
export function usePortalContainer(): HTMLElement | undefined {
	return React.useContext(PortalContainerContext) ?? undefined;
}
