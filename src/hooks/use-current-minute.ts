import { useEffect, useState } from "react";

/** Refreshes relative dates while their view stays open. */
export function useCurrentMinute() {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}
