import { useCallback, useState } from "react";
import { LOCAL_COLUMNS_STORAGE_KEY, parseLocalColumns } from "@/lib/local-column-storage";

const WELCOME_KEY = "todoflare-welcomed";

function hasBeenWelcomed(): boolean {
	try {
		return localStorage.getItem(WELCOME_KEY) === "true";
	} catch {
		return false;
	}
}

function hasExistingData(): boolean {
	try {
		const columns = parseLocalColumns(localStorage.getItem(LOCAL_COLUMNS_STORAGE_KEY));
		return columns?.some(({ value }) => value.length > 1 ||
			value[0]?.children.some((child) => typeof child.text === "string" && child.text.trim().length > 0)
		) ?? false;
	} catch {
		return false;
	}
}

function markAsWelcomed(): void {
	try {
		localStorage.setItem(WELCOME_KEY, "true");
	} catch (error) {
		console.error("Failed to save welcome state to localStorage:", error);
	}
}

export function useFirstVisit() {
	const [isFirstVisit, setIsFirstVisit] = useState(() => {
		// Don't show welcome if user has been welcomed before OR has existing data
		return !hasBeenWelcomed() && !hasExistingData();
	});

	const dismissWelcome = useCallback(() => {
		markAsWelcomed();
		setIsFirstVisit(false);
	}, []);

	return { isFirstVisit, dismissWelcome };
}
