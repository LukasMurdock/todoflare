"use client";

import * as React from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

interface WelcomeRefsContextValue {
	registerRef: (key: string, element: HTMLElement | null) => void;
	refs: Map<string, HTMLElement>;
	/** Bumps whenever a registered element changes, so consumers re-measure. */
	version: number;
}

const WelcomeRefsContext = createContext<WelcomeRefsContextValue | null>(null);

export function WelcomeRefsProvider({ children }: { children: React.ReactNode }) {
	const refsMap = useRef<Map<string, HTMLElement>>(new Map());
	const [version, setVersion] = useState(0);

	const registerRef = useCallback((key: string, element: HTMLElement | null) => {
		if (element) {
			if (refsMap.current.get(key) !== element) {
				refsMap.current.set(key, element);
				setVersion((n) => n + 1);
			}
		} else if (refsMap.current.has(key)) {
			refsMap.current.delete(key);
			setVersion((n) => n + 1);
		}
	}, []);

	const value = useMemo(
		() => ({ registerRef, refs: refsMap.current, version }),
		[registerRef, version],
	);

	return <WelcomeRefsContext.Provider value={value}>{children}</WelcomeRefsContext.Provider>;
}

export function useWelcomeRefs(): WelcomeRefsContextValue {
	const context = useContext(WelcomeRefsContext);
	if (!context) {
		throw new Error("useWelcomeRefs must be used within a WelcomeRefsProvider");
	}
	return context;
}

const noopRefs: WelcomeRefsContextValue = {
	registerRef: () => {},
	refs: new Map(),
	version: 0,
};

// Optional hook that silently returns no-op if outside provider
// Useful for components that may or may not be in a welcome context
export function useWelcomeRefsOptional(): WelcomeRefsContextValue {
	return useContext(WelcomeRefsContext) ?? noopRefs;
}
