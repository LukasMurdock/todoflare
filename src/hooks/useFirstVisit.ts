import { useCallback, useState } from "react";

const WELCOME_KEY = "todoflare-welcomed";
const COLUMNS_KEY = "todoflare-columns";

function hasBeenWelcomed(): boolean {
	try {
		return localStorage.getItem(WELCOME_KEY) === "true";
	} catch {
		return false;
	}
}

function hasExistingData(): boolean {
	try {
		const stored = localStorage.getItem(COLUMNS_KEY);
		if (!stored) return false;
		
		const parsed = JSON.parse(stored);
		if (!Array.isArray(parsed) || parsed.length === 0) return false;
		
		// Check if any column has actual content (not just empty default)
		return parsed.some((column: { value?: unknown[] }) => {
			if (!column.value || !Array.isArray(column.value)) return false;
			// Check if value has more than one block or the first block has content
			if (column.value.length > 1) return true;
			if (column.value.length === 1) {
				const firstBlock = column.value[0] as { children?: { text?: string }[] };
				// Check if the first block has any text content
				if (firstBlock.children && Array.isArray(firstBlock.children)) {
					return firstBlock.children.some(
						(child) => child.text && child.text.trim().length > 0
					);
				}
			}
			return false;
		});
	} catch {
		return false;
	}
}

function markAsWelcomed(): void {
	try {
		localStorage.setItem(WELCOME_KEY, "true");
	} catch (e) {
		console.error("Failed to save welcome state to localStorage:", e);
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
