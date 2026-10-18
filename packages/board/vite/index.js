import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./unused-providers.js", import.meta.url));

/**
 * Vite plugin for hosts of @todoflare/board: replaces the WebRTC, Hocuspocus
 * and IndexedDB providers that @platejs/yjs imports but the board never uses
 * (about 120 KiB minified) with stubs that throw if constructed.
 */
export function excludeUnusedYjsProviders() {
	return {
		name: "todoflare-board:exclude-unused-yjs-providers",
		enforce: "pre",
		resolveId(source) {
			if (source === "y-webrtc" || source === "@hocuspocus/provider" || source === "y-indexeddb") return stub;
			return null;
		},
	};
}
