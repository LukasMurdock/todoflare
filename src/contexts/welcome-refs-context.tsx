"use client";

import * as React from "react";
import { createContext, useCallback, useContext, useRef, useState } from "react";

interface WelcomeRefsContextValue {
	registerRef: (key: string, element: HTMLElement | null) => void;
	refs: Map<string, HTMLElement>;
}

const WelcomeRefsContext = createContext<WelcomeRefsContextValue | null>(null);

export function WelcomeRefsProvider({ children }: { children: React.ReactNode }) {
	const refsMap = useRef<Map<string, HTMLElement>>(new Map());
	const [, forceUpdate] = useState(0);

	const registerRef = useCallback((key: string, element: HTMLElement | null) => {
		if (element) {
			if (refsMap.current.get(key) !== element) {
				refsMap.current.set(key, element);
				forceUpdate((n) => n + 1);
			}
		} else {
			if (refsMap.current.has(key)) {
				refsMap.current.delete(key);
				forceUpdate((n) => n + 1);
			}
		}
	}, []);

	return (
		<WelcomeRefsContext.Provider value={{ registerRef, refs: refsMap.current }}>
			{children}
		</WelcomeRefsContext.Provider>
	);
}

export function useWelcomeRefs(): WelcomeRefsContextValue {
	const context = useContext(WelcomeRefsContext);
	if (!context) {
		throw new Error("useWelcomeRefs must be used within a WelcomeRefsProvider");
	}
	return context;
}

// Optional hook that silently returns no-op if outside provider
// Useful for components that may or may not be in a welcome context
export function useWelcomeRefsOptional(): WelcomeRefsContextValue {
	const context = useContext(WelcomeRefsContext);
	if (!context) {
		return {
			registerRef: () => {},
			refs: new Map(),
		};
	}
	return context;
}
