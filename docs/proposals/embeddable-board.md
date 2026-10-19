# Embeddable board

Goal: turn the todo board into an embeddable, extensible React component
(`packages/board` in this workspace) and rebuild todoflare on its public API
only, the way Excalidraw's app consumes `@excalidraw/excalidraw`. A second and
third host (minimal offline, adversarial server-rendered) prove the boundary.

Step 1 (measurement and API draft) changed no product code. Step 2 (seams in
place) and step 3 (package, hosts, proof) are recorded under
[Step 2 results](#step-2-results) and [Step 3 results](#step-3-results). The
embedding guide is [packages/board/README.md](../../packages/board/README.md).

## How to reproduce

```sh
node scripts/analysis/board-boundary.mjs            # imports and hazards across the boundary (--check: enforced in verify)
node scripts/analysis/ssr-probe.mjs                 # import and render the board in plain Node
vite build --sourcemap  # in a scratch worktree; dist/ holds release artifacts
node scripts/analysis/bundle-attribution.mjs DIR/dist/client/assets
pnpm build:e2e && pnpm test:visual --update-snapshots   # capture visual baseline (machine-specific)
pnpm build:e2e && pnpm test:visual                      # compare, 0 pixels allowed
pnpm check:board-api                                # public API matches packages/board/api-report.md
pnpm test:hosts                                     # the board in examples/minimal and examples/void
```

Zones are declared once in `scripts/analysis/board-zones.mjs`; since step 3
the board zone is the `packages/board/src` package.

## Baseline (main at 6d965237)

| Measure | Value |
| --- | --- |
| Proposed board zone | 57 files, 4,377 lines |
| Host zone (app, sync, storage, accounts) | 56 files, 9,870 lines |
| Board → host imports | **12** (all value imports, 1 side-effect only) |
| Host modules the board pulls in transitively | **47 files, 8,896 lines** (90% of the host) |
| Embedding hazards in board modules | **12** |
| Board modules importable in Node | 57/57 |
| Board entry points renderable without the app's provider | **0/3** |
| Client JS | 1 chunk, 1,407 KiB min, 422 KiB gzip, 348 KiB brotli |
| Client CSS | 55 KiB min, 9.9 KiB gzip |
| JS by origin | dependencies 89.3%, host 8.4%, board 2.3% |
| Visual baseline | 6 screens; 3 repeat runs, 0 pixels different |

### What the board needs from the host

The 12 crossings define the adapter surface. Grouped by what the board uses:

| Need | Today | Proposed seam |
| --- | --- | --- |
| Which columns exist, ownership, add/remove/reorder | `useColumns` (wraps `useSyncContext`) | controlled `columns` prop + intent callbacks |
| Column content and live collaboration | `useSyncContext()`: `loadColumnDocument`, `subscribeToColumn`, `onColumnMessage`, `sendUpdate`, `sendAwareness` + side-effect import of the Cloudflare provider | `DocumentAdapter.open(columnId) → { doc: Y.Doc, awareness, release }` |
| Whether editing is allowed | `useSyncContext()`: `browserStorageError`, `syncStateSummary.storageState` | `column.readOnly` |
| Cursor label and color | `lib/account`: `displayAccountId`, `getAccountColor` | `identity` prop |
| "Shared by …" header text | `lib/account`: `truncateAccountId` | `column.label` |
| Share menu, presence avatars | `ShareMenu`, `PresenceAvatars → usePresence → useSyncContext` | `renderColumnActions(column)` |
| Banners and account badge | `TodoApp` renders `ReconnectBanner`, `StorageRecoveryBanner`, `AccountBadge` | `renderTopBar()`; the badge moves outside the board |
| Welcome tour anchors | `welcome-refs-context` (`registerRef`) | `ref.getElement(part)` |
| Authenticated vs guest | `useAccount().isAuthenticated` | gone: the host decides by what it passes |

## Findings

1. **The board is the app.** Even `ColumnLayout` given plain props cannot render
   without `SyncProvider`, because `TodoColumn` reads `useSyncContext()` and
   `useAccount()` directly. Importing the board pulls in 90% of the host,
   including the IndexedDB database, the offline command queue, the XState
   machines, better-auth's client and every HTTP contract.

2. **A placeholder column appears before a signed-in account loads.** Until
   `GET /api/account` returns, a signed-in user sees the guest placeholder
   column (an editable empty column) and it vanishes when the account's real
   column list arrives. Found while capturing the visual baseline:
   `ensureColumnExists` saw the placeholder and skipped creating a column, then
   the column disappeared. Anything typed there in that window goes to guest
   storage. The API draft makes "not ready" explicit (`status: "loading"`).

3. **Page-global state.** `TodoColumn.tsx` keeps the Cmd-key state in module
   variables (`cmdKeyPressed`, `cmdKeyListeners`) and registers three `window`
   listeners at import time, for the lifetime of the page. `useKeyboardShortcut`
   listens on `window`, so two boards on one page would both open their help
   dialog on Mod+/. `useKeyboardShortcut` also reads `navigator` at import.

4. **Global registry.** The Cloudflare provider registers itself with
   `@platejs/yjs`'s process-wide `registerProviderType("cloudflare", …)` as an
   import side effect. `YjsPlugin` also accepts a caller-supplied `ydoc`,
   `awareness` and provider *instances*, so the host can own the transport and
   the registry is unnecessary (verified in `@platejs/yjs` 53 typings).

5. **The board escapes its container.** The shortcuts button is
   `position: fixed` at the page's bottom-left, the account badge is fixed at
   the top-right, and Radix dialogs portal into `document.body`, outside any
   board root. Theme variables are declared on `:root` and `.dark`. An embedded
   board would draw over host UI and its dialogs would lose scoped styles.

6. **Two editor code paths.** `TodoEditor` has a guest path (Plate JSON kept in
   sync with `localStorage` by serialize-and-compare) and a signed-in path
   (Yjs). If the board always edits a `Y.Doc` and guest hosts persist Plate JSON
   from `onContentChange`, the editor has one path and guest storage keeps its
   current format.

7. **About 120 KiB of unused collaboration code ships.** `@platejs/yjs`'s
   entry statically imports its WebRTC provider (`y-webrtc`, which pulls in
   `simple-peer`, 95 KiB minified) and `@hocuspocus/provider` (26 KiB). Todoflare uses neither. That
   is 9% of all client JS, and it would ship with the board to every host.

8. **Smaller items.** `useDebouncedEffect` is unused. The whole app is one
   chunk, so the public view downloads the editor, auth client and sync engine.
   The delete-confirmation trigger has no accessible name.

## API draft

*Historical: the step 1 draft (`docs/proposals/embeddable-board/`) was retired
in step 3, replaced by the real API report and example hosts.* The draft
public API followed
Excalidraw's four mechanisms and adds a fifth:

| Mechanism | Draft |
| --- | --- |
| Props | `columns` (controlled), `documents`, `status`, `identity`, `theme`, `readOnly` per column, `snapshot` per column |
| Callbacks | `onCreateColumn`, `onRemoveColumn`, `onReorderColumns`, `onCollapsedChange`, `onContentChange`, `onError`, `onOpenLink` |
| Imperative API (`ref`) | `focusColumn`, `scrollToColumn`, `getColumnContent`, `openShortcutsHelp`, `getElement` |
| Extension points | `renderColumnActions`, `renderTopBar`, `editorPlugins` |
| Adapters | `DocumentAdapter.open(columnId, signal)`; `createMemoryDocuments` and `useLocalBoard` for simple hosts |

Three hosts were written against it and type-checked by `pnpm check:board-spec`
(retired in step 3 with the draft; renaming one prop broke all three):

- `hosts/minimal.tsx`: about 25 lines, memory documents mirrored to
  `localStorage`.
- `hosts/todoflare.tsx`: the app on the public API. The Cloudflare adapter wraps
  today's cache and socket. Share menu and presence go through
  `renderColumnActions`. `status` comes from account hydration, which removes
  finding 2.
- `hosts/void/pages/`: a [Void](https://void.cloud/guide/) island page
  (`with { island: "load" }`). It is server-rendered on Workers and then
  hydrated, with a hostile global stylesheet. It renders `snapshot` content as
  HTML on the server.

The type-check already changed the draft once: intent callbacks returned
`void | Promise<void>`, which rejected todoflare's real `Promise<boolean>`
functions. They now return `unknown` and the board only awaits them.

## Proposed defaults (your call)

| Decision | Default | Why |
| --- | --- | --- |
| Distribution | Workspace package `packages/board` only | As requested; no npm publishing, so `publint`/`attw` are out of scope for now |
| Collaboration | Adapter, owned by the host | The board knows `Y.Doc` and `Awareness` only; Cloudflare, IndexedDB and tickets stay in the app (findings 1, 4) |
| Guest mode | Board always edits a `Y.Doc`; the guest adapter persists Plate JSON to today's `localStorage` keys | One editor path (finding 6), no data migration |
| Public read-only view | Stays in the app, but renders with the board's exported static column renderer | The same renderer serves `snapshot` during SSR |
| Column list | Controlled, with `useLocalBoard` for hosts that do not own membership | In todoflare the server owns membership and order |
| React | 19 only (`ref` as a prop) | Supporting 18 adds `forwardRef` and a second test matrix with no current consumer |
| CSS | Prebuilt CSS, variables and classes scoped under the board root, dialogs portaled into the root | Finding 5; class-level selectors outrank a host's element and `*` rules |

## Targets for the next steps

| Measure | Baseline | Target | Checked by |
| --- | ---: | ---: | --- |
| Board → host imports | 12 | 0 | `check:architecture` zones (fails on a probe fixture) |
| Host modules reachable from the board | 47 | 0 | `board-boundary.mjs` |
| Embedding hazards in the board | 12 | 0 | `board-boundary.mjs` |
| Board entry points rendering in Node | 0/3 | 3/3, with `snapshot` HTML | `ssr-probe.mjs`, Void host |
| Visual change for users | 6 screens | 0 pixels | `test:visual` vs this baseline |
| Existing behavior | 326 unit, 27 e2e, staging drill | all pass unchanged | `pnpm verify`, `test:staging` |
| Two boards on one page | not possible | isolated (shortcuts, cursors, dialogs) | Playwright, adversarial host |
| Mount/unmount 100× | not measured | no listener, socket, Y.Doc or DOM growth | Playwright + CDP heap/listener counts |
| Client JS | 422 KiB gzip | ≤ 422 KiB gzip; stretch: −100 KiB by excluding `simple-peer` and Hocuspocus | `bundle-attribution.mjs`, size budget |
| Host feature without board edits | header action needs `TodoColumn.tsx` edit | 0 board files | change-cost scenario |
| Embedding from docs alone | not possible | working minimal embed in under 15 minutes by an agent with no repo context | cold-start trial, friction log |

## Step 2 results

Six changes, each verified with `pnpm verify` and the visual baseline:

1. **Loading state.** Fixes the placeholder-column bug (finding 2). The new
   e2e test fails on the old code and passes on the new.
2. **Board-owned modifier-key state.** No module state or import-time
   listeners; the platform symbol is hydration-safe.
3. **Overlays inside the board.** Dialogs, popovers, menus and tooltips
   portal into the board root (an e2e test fails if they land in `body`).
4. **Document adapter.** The app's Cloudflare adapter opens each column's
   `Y.Doc`; Plate's global provider registry is no longer used.
5. **Guests on Yjs.** One editor path. Until a document opens, the board
   renders the column snapshot with static plugins declared beside the live
   ones; a build whose documents never opened rendered the guest board with 0
   pixels different from the live baseline.
6. **`TodoBoard`.** `components/board/TodoBoard.tsx` with the props, slots and
   ref from `components/board/types.ts`; `TodoApp` is now the host.

Two e2e tests that relied on the placeholder column were tightened
(`ensureColumnExists` matched any column POST; an offline test compared
against an unsettled snapshot).

| Measure | Baseline | After step 2 | Target |
| --- | ---: | ---: | ---: |
| Board → host imports | 12 | **0**, enforced by `check:board-boundary` | 0 |
| Host modules reachable from the board | 47 (8,896 lines) | **0** | 0 |
| Embedding hazards in the board | 12 | **1** (default `window.open` for Cmd+click; `onOpenLink` is in the draft) | 0 |
| Board entry points rendering in Node | 0/3 | **3/3**, with snapshot HTML | 3/3 |
| Visual change | – | **0 pixels** on all 6 screens after every change | 0 |
| Unit / e2e tests | 326 / 27 | **330 / 31**, all passing | all pass |
| Client JS (gzip) | 421.9 KiB | **423.3 KiB** (+1.4 KiB: snapshot plugins and board code) | ≤ 421.9 KiB |

Behavior changes, all intended: signed-in users no longer see a placeholder
column while loading; guests now get Yjs undo history (as signed-in users
already did); guest saves skip selection-only changes.

Not done yet, and planned for step 3: the package move; `focusColumn`,
`scrollToColumn`, `getColumnContent`, `onOpenLink`, `onError` and
`editorPlugins` from the draft; the board's own `position: fixed` shortcuts
button; type-checking the host examples against the real types instead of
the draft; the minimal and Void hosts; the bundle trim.

## Step 3 results

1. **Package.** `packages/board` (`@todoflare/board`) holds the board's 28
   modules with one public entry. The app imports only `@todoflare/board`;
   `check:board-boundary` fails on any import from the package into the app
   and on any deep import from the app into the package.
2. **API.** The draft's remaining pieces: `onOpenLink`, `onError` (adapter,
   editor and rejected-callback failures), `editorPlugins`, `layout`
   (`"fill"` / `"page"`), `shortcutsButton`, `id`, and the ref's
   `focusColumn`, `scrollToColumn` and `getColumnContent`.
   `packages/board/api-report.md` lists every export; `check:board-api` fails
   when code and report differ. The package also compiles under create-vite's
   strict settings, since it ships TypeScript source.
3. **Styles.** One palette in the package (`styles/tokens.css`). Todoflare
   compiles the board's Tailwind source; other hosts import the prebuilt
   `board.css`, whose reset is scoped to the board and unlayered, with
   `!important` utilities, so a host's global CSS does not restyle it.
4. **Hosts.** `examples/minimal` (plain Vite + React, no Tailwind) and
   `examples/void` (a [Void](https://void.cloud/guide/) island: server
   rendered on the Workers runtime, then hydrated). `pnpm test:hosts` (in
   `verify`) covers persistence, every callback, `onOpenLink`, host editor
   plugins, the ref, a failing adapter, two isolated boards on one page,
   StrictMode, hostile global CSS, 50 mount/unmount cycles with no listener or
   DOM growth (a one-listener-per-mount leak fails it), server HTML, the
   no-JavaScript render, hydration without mismatch warnings, and
   pixel-identical columns before and after hydration.
5. **Bundle.** `excludeUnusedYjsProviders()` (`@todoflare/board/vite`) drops
   the WebRTC, Hocuspocus and IndexedDB providers Plate imports but the board
   never constructs. `check:bundle-size` enforces a 395 KiB gzip budget.
6. **Public page.** It now renders with the board's `ColumnSnapshot`, so
   headings and todos look as they do in the editor (it showed plain lines).
7. **Cold-start trials.** An agent given only the README and API report
   embedded the board in a new Vite app in 3.8 minutes, all requirements met
   and verified. Its friction log (strict-mode type errors in the package
   source, no `Value` export, missing persistence recipe and control names)
   was fixed. A second fresh agent, using create-vite's strict defaults, met
   all five requirements (including a server render) in about 2 minutes
   without reading package source; its remaining friction was documentation
   (block format, theme variables, slot styling, expected warnings), now in
   the README.

Along the way: Void's dependencies (database drivers, a newer better-auth)
re-resolved the app's own `better-auth` with optional peers when the example
joined the workspace, so `examples/void` is its own pnpm project and installs
the board as a package copy. The 33 unused registry files in
`components/ui` and `editor/plugins` are deleted.

| Measure | Baseline | Step 2 | Step 3 | Target |
| --- | ---: | ---: | ---: | ---: |
| Board → host imports | 12 | 0 | **0**, enforced | 0 |
| Host modules reachable from the board | 47 | 0 | **0** | 0 |
| Embedding hazards | 12 | 1 | **1**: the default link opener (`onOpenLink` overrides it) | 0 |
| Board renders on a server | 0/3 | 3/3 | **3/3**, and in a real SSR host with hydration | 3/3 |
| Visual change for users | – | 0 px | **0 px**, except the public page (deliberate) | 0 |
| Tests | 326 / 27 | 330 / 31 | **330 unit, 32 e2e, 14 host** | all pass |
| Client JS (gzip) | 421.9 KiB | 423.3 KiB | **385.4 KiB** (board code 30.5 KiB minified) | ≤ 421.9 KiB |
| Time to embed from the docs | not possible | – | **3.8 min**, then **~2 min** after fixes | < 15 min |
| Host feature needs board edits | yes (`TodoColumn.tsx`) | no | **no**: slots, adapters, plugins | 0 board files |

Staging: version `388d3bf1` (this branch at `abda8dc5`) passed the passkey
test and the full recovery/rollback drill. Production is unchanged.

Deliberate duplicates: the app and the package each own their shadcn
`dialog` and the `cn` helper (shadcn's copy-per-package convention), and the
app's page-wide shortcut keeps its own one-line platform check.

## Proposed order of work

1. **Seams in place, no move yet.** Fix the placeholder flash with an explicit
   loading state; remove module state and import-time listeners; scope keyboard
   handling to the board; portal dialogs into the board root; replace the
   Cloudflare provider registration with a host-owned `Y.Doc` adapter; add the
   header-actions and top-bar slots. Each change keeps `pnpm verify` and the
   visual baseline at 0 pixels.
2. **Package.** Create `packages/board` with one public entry, move the board
   zone, turn the zones into enforced `check:architecture` rules, and check in
   an API Extractor report.
3. **Hosts.** Rebuild the app on the package; add the minimal host and the Void
   SSR host, each with Playwright tests (StrictMode, two boards, hostile CSS,
   server render and hydrate), the mount/unmount leak test and bundle budgets.
4. **Proof.** Staging deploy and drill, the change-cost scenario, and a
   cold-start embedding trial.

Risks: `@platejs/yjs` may bind more tightly to its provider registry than its
typings suggest (step 1 checks this first); moving guest mode onto Yjs touches
the storage-recovery e2e path; the Void host adds a new toolchain to the
workspace.
