import { useEffect, useRef } from "react";

/**
 * Runs an effect after a debounce delay. The effect is also flushed
 * on unmount and on beforeunload to prevent data loss.
 *
 * Skips execution on initial mount to avoid redundant operations
 * when the initial state matches the persisted state.
 */
export function useDebouncedEffect(
	effect: () => void,
	deps: React.DependencyList,
	delay: number = 500
): void {
	const timeoutRef = useRef<number | null>(null);
	const effectRef = useRef(effect);
	const isFirstRender = useRef(true);

	// Keep effect ref up to date
	effectRef.current = effect;

	useEffect(() => {
		// Skip on initial mount
		if (isFirstRender.current) {
			isFirstRender.current = false;
			return;
		}

		// Clear any existing timeout
		if (timeoutRef.current !== null) {
			clearTimeout(timeoutRef.current);
		}

		// Schedule new debounced execution
		timeoutRef.current = window.setTimeout(() => {
			effectRef.current();
			timeoutRef.current = null;
		}, delay);

		// Cleanup on deps change
		return () => {
			if (timeoutRef.current !== null) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, deps); // eslint-disable-line react-hooks/exhaustive-deps

	// Flush on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current !== null) {
				clearTimeout(timeoutRef.current);
				effectRef.current();
			}
		};
	}, []);

	// Flush on beforeunload
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (timeoutRef.current !== null) {
				effectRef.current();
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, []);
}
