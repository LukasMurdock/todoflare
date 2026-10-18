// Island page: static HTML except the board, which hydrates on load. A hostile
// global stylesheet proves the board's CSS holds up inside someone else's page.
import "@todoflare/board/board.css";
// Void detects islands from a default import with the attribute; keep type imports separate.
import type { BoardIslandProps } from "./_Board";
import BoardIsland from "./_Board" with { island: "load" };

const HOSTILE_CSS = `
	* { font-family: serif; margin: 4px; box-sizing: content-box; }
	button { all: unset; color: red; }
	div { line-height: 3; }
	ul, ol { list-style: square; padding-left: 60px; }
`;

export default function Home({ columns }: BoardIslandProps) {
	return (
		<main>
			<style>{HOSTILE_CSS}</style>
			<h1>Void host</h1>
			<BoardIsland columns={columns} />
		</main>
	);
}
