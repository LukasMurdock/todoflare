/**
 * Account ID utilities
 *
 * Mullvad-style 16-digit account IDs formatted with spaces: "4829 1047 3856 2019"
 */

/**
 * Generate a new random account ID
 * Returns formatted string: "4829 1047 3856 2019"
 */
export function generateAccountId(): string {
	const digits: string[] = [];
	for (let i = 0; i < 16; i++) {
		digits.push(Math.floor(Math.random() * 10).toString());
	}
	return formatAccountIdRaw(digits.join(""));
}

/**
 * Format a raw 16-digit string into spaced format
 * "4829104738562019" -> "4829 1047 3856 2019"
 */
function formatAccountIdRaw(raw: string): string {
	const clean = raw.replace(/\D/g, "").slice(0, 16);
	const groups: string[] = [];
	for (let i = 0; i < clean.length; i += 4) {
		groups.push(clean.slice(i, i + 4));
	}
	return groups.join(" ");
}

/**
 * Format account ID input as user types
 * Auto-inserts spaces after every 4 digits
 */
export function formatAccountId(input: string): string {
	// Remove all non-digits
	const digits = input.replace(/\D/g, "").slice(0, 16);
	return formatAccountIdRaw(digits);
}

/**
 * Validate account ID format
 * Must be exactly 16 digits (with or without spaces)
 */
export function validateAccountId(id: string): boolean {
	const digits = id.replace(/\D/g, "");
	return digits.length === 16 && /^\d{16}$/.test(digits);
}

/**
 * Normalize account ID for storage/lookup
 * Removes spaces, ensures consistent format
 * "4829 1047 3856 2019" -> "4829104738562019"
 */
export function normalizeAccountId(id: string): string {
	return id.replace(/\D/g, "");
}

/**
 * Get display format for account ID (with spaces)
 * "4829104738562019" -> "4829 1047 3856 2019"
 */
export function displayAccountId(id: string): string {
	return formatAccountIdRaw(normalizeAccountId(id));
}

/**
 * Truncate account ID for display
 * "4829 1047 3856 2019" -> "4829...2019"
 */
export function truncateAccountId(id: string): string {
	const formatted = displayAccountId(id);
	const parts = formatted.split(" ");
	if (parts.length >= 4) {
		return `${parts[0]}...${parts[3]}`;
	}
	return formatted;
}

/**
 * Generate a short public ID for public links
 * 8 alphanumeric characters (base62)
 */
export function generatePublicId(): string {
	const chars =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let result = "";
	for (let i = 0; i < 8; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

/**
 * Generate a consistent color for an account ID
 * Used for presence indicators
 */
export function getAccountColor(accountId: string): string {
	const normalized = normalizeAccountId(accountId);
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		const char = normalized.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32-bit integer
	}

	// Generate HSL color with good saturation and lightness
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 70%, 50%)`;
}
