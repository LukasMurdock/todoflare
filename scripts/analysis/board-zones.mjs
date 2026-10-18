// Proposed zones for the embeddable board, shared by the boundary inventory and
// the bundle attribution. Moving a file between zones is a one-line change here.

/** Modules that would form the embeddable board package. */
export const BOARD_ZONE = [
	/^src\/components\/board\//,
	/^src\/components\/todo\/(ColumnLayout|TodoColumn)\.tsx$/,
	/^src\/components\/ui\//,
	/^src\/components\/editor\//,
	/^src\/components\/keyboard-shortcuts\.tsx$/,
	/^src\/types\/column\.ts$/,
	/^src\/lib\/utils\.ts$/,
];

/** Every other browser module is host (the todoflare application). */
export const zoneOf = (file) => (BOARD_ZONE.some((re) => re.test(file)) ? "board" : "host");
