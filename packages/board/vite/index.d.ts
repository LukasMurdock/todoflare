import type { Plugin } from "vite";

/** Replaces the Yjs providers @platejs/yjs imports but the board never uses with throwing stubs. */
export function excludeUnusedYjsProviders(): Plugin;
