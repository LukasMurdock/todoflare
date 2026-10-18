// Void island page: everything is static HTML except the board, which hydrates on load.
// The loader in index.server.ts reads the columns from D1 and passes them as props.
import BoardIsland, { type BoardIslandProps } from "./_Board" with { island: "load" };

export default function Home({ columns }: BoardIslandProps) {
	return (
		<main>
			<h1>Team board</h1>
			{/* Host styles deliberately reset everything to prove the board's CSS is self-contained. */}
			<style>{"* { all: revert; font-family: serif; box-sizing: content-box; }"}</style>
			<BoardIsland columns={columns} />
		</main>
	);
}
