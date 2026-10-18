// Stand-ins for the collaboration providers @platejs/yjs imports but the board
// never constructs: the board hands Plate its own provider instance. Hosts
// that use Plate's built-in providers elsewhere must not use the plugin.
function unused(name) {
	return class {
		constructor() {
			throw new Error(`${name} is excluded by @todoflare/board/vite (excludeUnusedYjsProviders).`);
		}
	};
}

export const HocuspocusProvider = unused("HocuspocusProvider");
export const HocuspocusProviderWebsocket = unused("HocuspocusProviderWebsocket");
export const WebrtcProvider = unused("WebrtcProvider");
export const IndexeddbPersistence = unused("IndexeddbPersistence");
