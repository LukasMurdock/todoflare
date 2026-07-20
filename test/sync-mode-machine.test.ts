import { describe, expect, it } from "vitest";
import { deriveSyncMode } from "../src/lib/sync/mode-machine";

describe("deriveSyncMode", () => {
	it("returns public_readonly when public route is active", () => {
		expect(
			deriveSyncMode({
				hasAccountSession: true,
				isPublicReadonly: true,
				isNetworkOnline: true,
				connectionStatus: "connected",
			}),
		).toBe("public_readonly");
	});

	it("returns guest_local when no account session exists", () => {
		expect(
			deriveSyncMode({
				hasAccountSession: false,
				isPublicReadonly: false,
				isNetworkOnline: true,
				connectionStatus: "connected",
			}),
		).toBe("guest_local");
	});

	it("returns account_offline when network is offline", () => {
		expect(
			deriveSyncMode({
				hasAccountSession: true,
				isPublicReadonly: false,
				isNetworkOnline: false,
				connectionStatus: "connected",
			}),
		).toBe("account_offline");
	});

	it("returns account_realtime when account is online and connected", () => {
		expect(
			deriveSyncMode({
				hasAccountSession: true,
				isPublicReadonly: false,
				isNetworkOnline: true,
				connectionStatus: "connected",
			}),
		).toBe("account_realtime");
	});

	it("returns account_syncing while online without an active realtime connection", () => {
		expect(
			deriveSyncMode({
				hasAccountSession: true,
				isPublicReadonly: false,
				isNetworkOnline: true,
				connectionStatus: "offline",
			}),
		).toBe("account_syncing");
	});
});
