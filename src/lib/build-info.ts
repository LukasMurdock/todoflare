/** The commit this bundle was built from, stamped by vite.config.ts. */
export interface BuildInfo {
	/** Short commit SHA, or "unknown" when the build had no git checkout. */
	commit: string;
	/** Commit date (ISO 8601). Never the build time: production builds must be reproducible. */
	committedAt: string | null;
	/** Tracked files differed from the commit. */
	dirty: boolean;
}

declare const __TODOFLARE_BUILD__: BuildInfo;

export const BUILD_INFO: BuildInfo =
	typeof __TODOFLARE_BUILD__ !== "undefined"
		? __TODOFLARE_BUILD__
		: { commit: "unknown", committedAt: null, dirty: false };

/** For people: "a1b2c3d4e5f6 · 2026-10-18", with "-dirty" after the SHA when it applies. */
export function formatBuild(info: BuildInfo = BUILD_INFO): string {
	const commit = info.dirty ? `${info.commit}-dirty` : info.commit;
	return info.committedAt ? `${commit} · ${info.committedAt.slice(0, 10)}` : commit;
}
