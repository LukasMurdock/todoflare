import { normalizeAccountId } from "./account";

declare const __TODOFLARE_E2E__: boolean;

/** Legacy fixture transport compiled only into the isolated Playwright build. */
export function e2eAccountHeaders(accountId: string): Record<string, string> {
	return usingE2EAuthFixture()
		? { "X-Todoflare-Test-Account": normalizeAccountId(accountId) }
		: {};
}

export function usingE2EAuthFixture(): boolean {
	return typeof __TODOFLARE_E2E__ !== "undefined" && __TODOFLARE_E2E__;
}
