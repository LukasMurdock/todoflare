# Design Capture & Hill-Climb Feed

Automated Playwright screen capture across every Todoflare UI surface, account configuration, theme, viewport, and interactive flow — outputting an interactive HTML review feed, agent-readable contact sheets, DOM layout diagnostics, and before/after pixel diffs for iterative design hill climbs.

## Quick start

```bash
# Capture the full catalog of Todoflare UI surfaces (light, desktop)
pnpm capture:ui

# Full responsive + theme sweep (light & dark × desktop & mobile)
pnpm capture:ui:all

# List all built-in scenarios
pnpm capture:ui --list
```

Open `.design-review/<run>/index.html` in a browser to browse the interactive review feed, or `.design-review/index.html` for all runs.

## Design Hill-Climb Loop

```bash
# 1. Capture baseline before editing UI
pnpm capture:ui --run baseline --themes light,dark

# 2. Make design/UI edits, then capture and diff against baseline
#    (filter to just the surfaces you're iterating on for a ~10s loop!)
pnpm capture:ui --run iter-01 --compare baseline --filter "share-*,agents-*" --themes light,dark

# 3. Inspect .design-review/iter-01/index.html (Before/After Slider, Side-by-Side, Pixel Diff)
#    or read .design-review/iter-01/contact-sheets/*.png and manifest.json directly.
```

## Capture Any Arbitrary Flow or State (`--spec`)

Pass a declarative JSON spec to capture any custom account state (guest, signed-in, peer sharing, public links, MCP agent grants & tool calls, OAuth consent, offline mode, expired session) and step sequence — with optional `.mp4` flow video:

```bash
pnpm capture:ui --spec design-capture/example-spec.json --video --run custom-pass
```

## Output Layout (`.design-review/<run>/`)

- `index.html` — self-contained interactive UI Review Feed (category/theme/viewport filters, Grid vs Feed view, Before/After slider & pixel diff, lightbox inspector, and "Copy Hill-Climb Brief" note exporter)
- `manifest.json` — structured inventory with image/video paths, DOM overflow/clipped-popup/console-error diagnostics, and pixel diff stats
- `contact-sheets/*.png` — 4-up labelled PNG grids per category so agents can visually audit an entire surface group in one image read
- `shots/*.png` — full-resolution captures
- `diffs/*.diff.png` — pixel-level diff overlays (when `--compare` is used)
- `videos/*.mp4` — H.264 flow recordings (when `--video` is used)
