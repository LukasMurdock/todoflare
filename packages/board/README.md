# @todoflare/board

The todo board from [todoflare](../../README.md) as an embeddable React
component: columns of rich-text todo lists you can reorder, collapse, share
live through Yjs, and render on a server.

The board owns editing. Your app (the *host*) owns everything else: who the
user is, where content is stored, how it syncs, sharing, and page chrome. The
same component runs todoflare itself (`src/components/todo/TodoApp.tsx`), a
plain client-side page (`examples/minimal`), and a server-rendered Void island
(`examples/void`).

The full public API is in [api-report.md](./api-report.md). Anything not
exported from the package entry is internal.

## Quick start

Requirements: React 19, and Vite (or another bundler that understands
package `exports` and CSS imports).

The package is not published. Inside this workspace, depend on
`"@todoflare/board": "workspace:*"`. From a separate project, install it from
the folder, which copies it and resolves its dependencies (including React)
in your project:

```sh
# Use the absolute path of your todoflare checkout. Building the CSS needs the
# repo's own dependencies installed (pnpm install there).
node /Users/you/code/todoflare/packages/board/build-css.mjs   # writes dist/board.css
pnpm add file:/Users/you/code/todoflare/packages/board
```

The package ships TypeScript source and compiles under strict settings
(including create-vite's `noUnusedLocals`). Content is typed as `Value`,
re-exported by the package, so you do not need a direct `platejs` dependency.

```tsx
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TodoBoard, createMemoryDocuments, type BoardColumn } from "@todoflare/board";
import "@todoflare/board/board.css";

const documents = createMemoryDocuments();

function App() {
	const [columns, setColumns] = useState<BoardColumn[]>([{ id: crypto.randomUUID(), removal: "delete" }]);
	return (
		<div style={{ height: "100vh" }}>
			<TodoBoard
				columns={columns}
				documents={documents}
				onCreateColumn={() => setColumns((list) => [...list, { id: crypto.randomUUID(), removal: "delete" }])}
				onRemoveColumn={(column) => setColumns((list) => list.filter((c) => c.id !== column.id))}
				onReorderColumns={(ids) => setColumns((list) => ids.map((id) => list.find((c) => c.id === id)!))}
				onCollapsedChange={(column, collapsed) =>
					setColumns((list) => list.map((c) => (c.id === column.id ? { ...c, collapsed } : c)))
				}
				onContentChange={(columnId, content) => console.log(columnId, content)}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
```

In your Vite config, add the provider trim next to your React plugin (saves
about 120 KiB, see below):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { excludeUnusedYjsProviders } from "@todoflare/board/vite";

export default defineConfig({ plugins: [react(), excludeUnusedYjsProviders()] });
```

The stylesheet is prebuilt: you do not need Tailwind. Inside this workspace,
build it with `pnpm --filter @todoflare/board build:css` (the example hosts'
`dev` scripts do this).

## Concepts

### Content format

Content is Plate JSON (`Value`): an array of blocks. The board's blocks are
paragraphs (`"p"`), headings (`"h1"` to `"h3"`), and list items, which are
paragraphs with `listStyleType` (`"disc"`, `"decimal"` or `"todo"`) and an
`indent` level:

```ts
const snapshot: Value = [
	{ type: "h1", children: [{ text: "Groceries" }] },
	{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "Milk" }] },
	{ type: "p", listStyleType: "disc", indent: 1, children: [{ text: "Bread" }] },
	{ type: "p", children: [{ text: "See example.com for details" }] },
];
```

### Columns are controlled

You pass the list of `columns`; the board never adds, removes or reorders
columns itself. It reports intents through callbacks, and you pass back the
new list. Omitting a callback hides its control (no `onCreateColumn`, no add
button).

```ts
interface BoardColumn {
	id: string;                              // stable; you choose the format
	collapsed?: boolean;
	readOnly?: boolean;                      // e.g. storage failed, offline freeze
	removal?: "none" | "delete" | "hide";    // header control; "delete" confirms if the column has content
	deleteNotice?: string;                   // what deleting means; default "This action cannot be undone."
	label?: string;                          // short header text, e.g. "Shared by …"
	snapshot?: Value;                        // last known content (Plate JSON)
}
```

Callbacks may return promises. The board does not wait for them to update the
UI; a thrown error or rejection goes to `onError` instead of escaping.

### Content lives in documents you provide

Every column edits a Yjs `Y.Doc` that the host opens through a
`DocumentAdapter`:

```ts
interface DocumentAdapter {
	open(columnId: string, signal: AbortSignal): Promise<{
		doc: Y.Doc;
		awareness?: Awareness;   // for live cursors; the board creates one if omitted
		release(): void;         // called when the column unmounts or switches documents
	}>;
}
```

Resolve `open` once the document holds whatever you could load (a cache, a
first sync). If it opens empty, the board seeds it from the column's
`snapshot`. Persist and sync the document however you like:

- **In memory**: `createMemoryDocuments()`. Save content from
  `onContentChange(columnId, content)`, which reports Plate JSON on every
  editor change (including selection moves; compare before writing), and pass
  it back as `snapshot` next time:

  ```tsx
  const [columns, setColumns] = useState<BoardColumn[]>(
  	() => JSON.parse(localStorage.getItem("board") ?? "null") ?? [{ id: crypto.randomUUID(), removal: "delete" }],
  );
  useEffect(() => localStorage.setItem("board", JSON.stringify(columns)), [columns]);
  // ...
  onContentChange={(columnId, content) =>
  	setColumns((list) => list.map((c) => (c.id === columnId ? { ...c, snapshot: content } : c)))
  }
  ```
- **Live collaboration**: connect the `Y.Doc` and `Awareness` to any Yjs
  transport. Todoflare's adapter (`createCloudflareDocuments` in
  `src/lib/collaboration/cloudflare-yjs-provider.ts`) applies an IndexedDB
  cache, then relays updates over a Durable Object socket. Pass `identity`
  (`{ name, color }`) to show this user's cursor to others.

### Snapshots and server rendering

Until a column's document opens, the board renders its `snapshot` as static
HTML that matches the editor pixel for pixel, so there is no loading flash and
a server render shows real content. On a server, documents never open.

`snapshot` is read when a column's document opens: it is shown while the
document loads and seeds it if it opens empty. Changing `snapshot` while the
column is open has no effect on the editor (the document is the source of
truth), so storing every change back into `snapshot` is safe.

The board renders on the server without `window`, `localStorage` or
IndexedDB. (On Node 26, importing Yjs prints a harmless "localStorage is not
available" warning: its `lib0` dependency checks for storage when loaded.)

```ts
// e.g. in a Vite SSR handler or a script using vite.ssrLoadModule
import { renderToString } from "react-dom/server";
import { TodoBoard, createMemoryDocuments } from "@todoflare/board";

const html = renderToString(
	<TodoBoard id="board" columns={[{ id: "a", snapshot }]} documents={createMemoryDocuments()} />,
);
```

Keep browser-only code (reading `localStorage` for saved columns, for example)
out of the module you render on the server, or run it in an effect. If your framework renders the board inside a page but
hydrates it as a separate React root (islands, as in Void or Astro), pass a
stable `id` so generated ids match:

```tsx
<TodoBoard id="team-board" … />
```

Use `status="loading"` while you do not yet know which columns exist; the
board then renders no columns and opens no documents.

### Layout

- `layout="fill"` (default): the board fills its container and each column
  scrolls inside it. Give the container a height, for example
  `<div style={{ height: 480 }}>` for a card-sized board inside a page, or
  `height: 100vh` for a full-screen one.
- `layout="page"`: the board is the page; columns grow with their content and
  the page scrolls.

The keyboard-shortcuts button sits at the board's bottom-left
(`shortcutsButton="board"`); use `"viewport"` to fix it to the window, or
`"none"`. Mod+/ toggles the shortcuts dialog when focus is inside the board;
call `ref.current.openShortcutsHelp()` from your own listener if you want it
page-wide.

### Extending

- `renderColumnActions(column)`: controls in each column header (todoflare
  renders its share menu and presence avatars here).
- `renderTopBar()`: content above the columns (banners, badges).
- `editorPlugins`: extra Plate plugins for the live editor. Pass a stable
  array. Snapshots render the built-in blocks only.
- `onOpenLink(url)`: Cmd/Ctrl+click on a link (default: new tab).
- `onError(error, { columnId, operation })`: adapter, editor and callback
  failures (default: `console.error`). The board stays mounted.
- Overlays you render from slots (popovers, menus) should portal into the
  board: pass `usePortalContainer()` as the portal container.
- Controls you render in slots are inside the board, so the board's reset
  applies to them: a plain `<button>` has no border, background or padding.
  Style them with your own classes or inline styles; the board's internal
  utility classes are not a supported styling API.

### Imperative API

A column is *open* while it is expanded and its editor is bound to its
document. Collapsed columns, and columns whose document has not opened yet,
are not open: fall back to your own saved `snapshot` for them.

```ts
const board = useRef<TodoBoardApi>(null);
board.current?.focusColumn(id);       // false if the column is not open; focus is asynchronous
board.current?.scrollToColumn(id);
board.current?.getColumnContent(id);  // Plate JSON, or null if not open
board.current?.openShortcutsHelp();
board.current?.getElement("add-column" | "first-column" | "shortcuts-button");
```

### Controls and keyboard

Column headers have buttons named "Reorder column" (drag handle; with the
keyboard, focus it and press Space, then the arrow keys, then Space),
"Collapse column" / "Expand column", and "Delete column" or "Hide column".
The board has "Add column" and "Keyboard shortcuts". These names are stable,
for tests of your embed.

## Styling

`@todoflare/board/board.css` is self-contained and scoped to
`[data-todo-board]`:

- Its reset applies only inside the board, and it overrides a host's
  universal and element rules (`* { font-family: serif }`,
  `button { all: unset }`), so the board looks the same on any page.
- Theme colors are CSS variables on `[data-todo-board]`. The board uses
  `--background` and `--foreground` (surface and text), `--muted` and
  `--muted-foreground` (column headers, placeholders, secondary text),
  `--primary` and `--primary-foreground` (checked todos, the link underline
  while Cmd/Ctrl is held), `--border`, `--input` (unchecked todo boxes),
  `--ring` (focus rings), `--accent` (hover backgrounds), `--brand` (text
  selection) and `--destructive` (invalid states). The palette also defines
  `--card`, `--popover`, `--secondary` and `--highlight` for hosts that opt in
  page-wide with `<html data-todo-theme>`. Override any of them:

  ```css
  [data-todo-board] { --primary: oklch(0.55 0.2 260); --border: #ddd; }
  ```

  Add the `dark` class to the board (or an ancestor) for the dark palette.
- Utilities are `!important`, so restyle the board through the variables, not
  by targeting its internal classes.
- Sizes use `rem`, so they follow your page's root font size.

If your app compiles Tailwind v4 itself, import the board's Tailwind source
instead of the prebuilt file (todoflare does):

```css
@import "tailwindcss";
@import "@todoflare/board/tailwind.css";
```

## Bundle size

The board and its editor (React, Slate, Plate, Yjs) are about 300 KiB gzip in
a minimal host, so Vite warns about a chunk over 500 KiB minified. Lazy-load
the board (`React.lazy`) if it is not on the first screen. A `"use no memo"`
directive warning from `react-compiler-runtime` (a Plate dependency) during
`vite build` is expected and harmless.

`@platejs/yjs` imports its WebRTC, Hocuspocus and IndexedDB providers even
though the board never uses them. `excludeUnusedYjsProviders()` from
`@todoflare/board/vite` replaces them with stubs (they throw if constructed).
Do not use it if your app constructs Plate's built-in Yjs providers itself.

## Limits

- React 19 only (`ref` is a prop).
- One editor feature set: headings, bulleted, numbered and todo lists,
  indentation, link detection. Add more with `editorPlugins`.
- Column metadata such as titles, colors or ordering rules beyond the list
  order belongs to the host.
