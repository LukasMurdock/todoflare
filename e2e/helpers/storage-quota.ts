/** Runs in Chromium, where localStorage charges quota for key and value lengths. */
export function exhaustLocalStorage() {
	const key = "quota-fixture-padding";
	let size = 0;
	for (let increment = 262_144; increment >= 1; increment /= 2) {
		try {
			while (true) {
				localStorage.setItem(key, "x".repeat(size + increment));
				size += increment;
			}
		} catch (error) {
			if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") {
				throw error;
			}
		}
	}
}
