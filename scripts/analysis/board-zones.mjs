// Zones for the embeddable board, shared by the boundary check, the SSR probe
// and the bundle attribution. The board is the @todoflare/board package; every
// other browser module is host (the todoflare application).

export const BOARD_ROOT = "packages/board/src";
export const BOARD_PACKAGE = "@todoflare/board";

export const zoneOf = (file) => (file.startsWith(`${BOARD_ROOT}/`) ? "board" : "host");
