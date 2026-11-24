import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

function run(cmd, argv) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("error", reject);
		p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-1500)}`))));
	});
}

/** Converts a Playwright .webm flow recording to a crisp .mp4 via ffmpeg. */
export async function convertWebmToMp4(webmPath, mp4Path) {
	await run(FFMPEG, [
		"-y",
		"-v",
		"error",
		"-i",
		webmPath,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-crf",
		"20",
		"-movflags",
		"+faststart",
		"-an",
		mp4Path,
	]);
}

/**
 * Computes pixel diffs between current run shots and a baseline run using a
 * single Playwright page with `<canvas>` (zero external npm deps!).
 */
export async function computeHillClimbDiffs(browser, { runDir, compareDir, shots }) {
	const compareManifestPath = path.join(compareDir, "manifest.json");
	if (!fs.existsSync(compareManifestPath)) {
		throw new Error(`Compare run not found: ${compareManifestPath}`);
	}
	const baseManifest = JSON.parse(fs.readFileSync(compareManifestPath, "utf8"));
	const baseByKey = new Map(baseManifest.shots.map((s) => [s.key, s]));
	const diffDir = path.join(runDir, "diffs");
	fs.mkdirSync(diffDir, { recursive: true });

	const page = await browser.newPage();
	try {
		await page.setContent("<!doctype html><html><body></body></html>");
		for (const shot of shots) {
			const base = baseByKey.get(shot.key);
			if (!base) {
				shot.compare = { status: "new" };
				continue;
			}
			const baseImgAbs = path.join(compareDir, base.image);
			const curImgAbs = path.join(runDir, shot.image);
			if (!fs.existsSync(baseImgAbs) || !fs.existsSync(curImgAbs)) continue;

			const baseDataUrl = `data:image/png;base64,${fs.readFileSync(baseImgAbs).toString("base64")}`;
			const curDataUrl = `data:image/png;base64,${fs.readFileSync(curImgAbs).toString("base64")}`;

			const result = await page.evaluate(async ([bUrl, cUrl]) => {
				const load = (src) =>
					new Promise((res, rej) => {
						const img = new Image();
						img.onload = () => res(img);
						img.onerror = rej;
						img.src = src;
					});
				const [a, b] = await Promise.all([load(bUrl), load(cUrl)]);
				const w = Math.max(a.width, b.width);
				const h = Math.max(a.height, b.height);
				const ca = document.createElement("canvas");
				const cb = document.createElement("canvas");
				const cd = document.createElement("canvas");
				ca.width = cb.width = cd.width = w;
				ca.height = cb.height = cd.height = h;
				const xa = ca.getContext("2d");
				const xb = cb.getContext("2d");
				const xd = cd.getContext("2d");
				xa.drawImage(a, 0, 0);
				xb.drawImage(b, 0, 0);
				const da = xa.getImageData(0, 0, w, h).data;
				const db = xb.getImageData(0, 0, w, h).data;
				const out = xd.createImageData(w, h);
				const dd = out.data;
				let diffPixels = 0;
				const total = w * h;
				for (let i = 0; i < da.length; i += 4) {
					const dr = Math.abs(da[i] - db[i]);
					const dg = Math.abs(da[i + 1] - db[i + 1]);
					const dbv = Math.abs(da[i + 2] - db[i + 2]);
					const daa = Math.abs(da[i + 3] - db[i + 3]);
					const delta = Math.max(dr, dg, dbv, daa);
					if (delta > 6) {
						diffPixels++;
						// Vivid magenta/coral highlight for changed pixels
						dd[i] = 244;
						dd[i + 1] = 63;
						dd[i + 2] = 94;
						dd[i + 3] = 255;
					} else {
						// Soft muted luminance ghost of current image for spatial context
						const lum = Math.round((db[i] * 0.299 + db[i + 1] * 0.587 + db[i + 2] * 0.114) * 0.28 + 184);
						dd[i] = lum;
						dd[i + 1] = lum;
						dd[i + 2] = lum;
						dd[i + 3] = 255;
					}
				}
				xd.putImageData(out, 0, 0);
				return {
					diffPixels,
					totalPixels: total,
					diffPercent: Number(((diffPixels / total) * 100).toFixed(3)),
					sizeChanged: a.width !== b.width || a.height !== b.height,
					diffPngBase64: diffPixels > 0 ? cd.toDataURL("image/png").split(",")[1] : null,
				};
			}, [baseDataUrl, curDataUrl]);

			const relBaseline = path.relative(runDir, baseImgAbs).split(path.sep).join("/");
			let relDiff = null;
			if (result.diffPngBase64) {
				const diffFile = `${shot.key.replace(/[^a-zA-Z0-9._-]/g, "_")}.diff.png`;
				fs.writeFileSync(path.join(diffDir, diffFile), Buffer.from(result.diffPngBase64, "base64"));
				relDiff = `diffs/${diffFile}`;
			}
			shot.compare = {
				status: result.diffPixels === 0 ? "identical" : "changed",
				baselineRun: path.basename(compareDir),
				baselineImage: relBaseline,
				diffImage: relDiff,
				diffPixels: result.diffPixels,
				diffPercent: result.diffPercent,
				sizeChanged: result.sizeChanged,
			};
		}
	} finally {
		await page.close();
	}
}

/**
 * Renders labelled high-res PNG contact sheets (one per category + an "all"
 * overview) so AI agents and reviewers can scan an entire suite in one read.
 */
export async function buildContactSheets(browser, { runDir, shots }) {
	const sheetDir = path.join(runDir, "contact-sheets");
	fs.mkdirSync(sheetDir, { recursive: true });
	const byCategory = new Map();
	for (const shot of shots) {
		const list = byCategory.get(shot.category) ?? [];
		list.push(shot);
		byCategory.set(shot.category, list);
	}

	const groups = [];
	for (const [cat, list] of byCategory) groups.push({ name: cat, list });
	if (shots.length > 1 && byCategory.size > 1) {
		// Also produce an "all" overview (capped cleanly per sheet if huge)
		groups.push({ name: "all", list: shots.slice(0, 36) });
	}

	const page = await browser.newPage();
	const created = [];
	try {
		await page.setContent("<!doctype html><html><body></body></html>");
		for (const { name, list } of groups) {
			if (list.length === 0) continue;
			const cols = list.length <= 2 ? list.length : list.length <= 6 ? 3 : 4;
			const tileW = 540;
			const tileH = 338;
			const pad = 16;
			const headerH = 42;
			const payload = list.map((s) => {
				const imgAbs = path.join(runDir, s.image);
				return {
					label: `${s.title}`,
					sub: `${s.id} · ${s.theme} · ${s.viewport.name}${s.compare?.diffPercent ? ` · Δ${s.compare.diffPercent}%` : ""}`,
					src: `data:image/png;base64,${fs.readFileSync(imgAbs).toString("base64")}`,
					hasIssue:
						(s.diagnostics?.consoleErrors?.length ?? 0) > 0 ||
						(s.diagnostics?.pageErrors?.length ?? 0) > 0 ||
						(s.diagnostics?.horizontalOverflowPx ?? 0) > 0 ||
						(s.diagnostics?.clippedPopups?.length ?? 0) > 0 ||
						(s.diagnostics?.edgeHuggingDialogs?.length ?? 0) > 0 ||
						(s.diagnostics?.fixedOverlaps?.length ?? 0) > 0,
				};
			});

			const pngBase64 = await page.evaluate(
				async ({ items, cols, tileW, tileH, pad, headerH }) => {
					const rows = Math.ceil(items.length / cols);
					const canvas = document.createElement("canvas");
					canvas.width = cols * tileW + (cols + 1) * pad;
					canvas.height = rows * (tileH + headerH) + (rows + 1) * pad;
					const ctx = canvas.getContext("2d");
					ctx.fillStyle = "#111114";
					ctx.fillRect(0, 0, canvas.width, canvas.height);

					for (let i = 0; i < items.length; i++) {
						const item = items[i];
						const img = new Image();
						img.src = item.src;
						await img.decode();
						const col = i % cols;
						const row = Math.floor(i / cols);
						const x = pad + col * (tileW + pad);
						const y = pad + row * (tileH + headerH + pad);

						// Header
						ctx.fillStyle = "#f4f4f5";
						ctx.font = '600 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
						ctx.fillText(item.label.slice(0, 48), x + 2, y + 17);
						ctx.fillStyle = item.hasIssue ? "#f87171" : "#a1a1aa";
						ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
						ctx.fillText(item.sub.slice(0, 62), x + 2, y + 34);

						// Frame container (aspect-fit)
						ctx.fillStyle = "#1c1c21";
						ctx.fillRect(x, y + headerH, tileW, tileH);
						const scale = Math.min(tileW / img.width, tileH / img.height);
						const dw = img.width * scale;
						const dh = img.height * scale;
						const dx = x + (tileW - dw) / 2;
						const dy = y + headerH + (tileH - dh) / 2;
						ctx.drawImage(img, dx, dy, dw, dh);
						ctx.strokeStyle = item.hasIssue ? "#ef4444" : "rgba(255,255,255,0.12)";
						ctx.lineWidth = 1;
						ctx.strokeRect(x + 0.5, y + headerH + 0.5, tileW - 1, tileH - 1);
					}
					return canvas.toDataURL("image/png").split(",")[1];
				},
				{ items: payload, cols, tileW, tileH, pad, headerH },
			);

			const outPath = path.join(sheetDir, `${name}.png`);
			fs.writeFileSync(outPath, Buffer.from(pngBase64, "base64"));
			created.push({ category: name, path: `contact-sheets/${name}.png`, count: list.length });
		}
	} finally {
		await page.close();
	}
	return created;
}

/** Writes the self-contained interactive UI Review Feed HTML for a run. */
export function writeReviewFeedHtml(runDir, manifest) {
	const jsonSafe = JSON.stringify(manifest).replace(/<\//g, "<\\/");
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Todoflare UI Review Feed — ${escapeHtml(manifest.run)}</title>
<style>
  :root {
    --bg: #0c0c0e; --surface: #141418; --surface-2: #1c1c22; --border: #27272f;
    --text: #f4f4f5; --muted: #a1a1aa; --accent: #3b82f6; --ok: #22c55e;
    --warn: #f59e0b; --danger: #ef4444; --radius: 10px;
  }
  :root.light {
    --bg: #f6f6f7; --surface: #ffffff; --surface-2: #f1f1f4; --border: #e4e4e7;
    --text: #141416; --muted: #63636a; --accent: #2563eb;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: var(--bg); color: var(--text); }
  a { color: inherit; }
  header.topbar {
    position: sticky; top: 0; z-index: 30; backdrop-filter: blur(12px);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    border-bottom: 1px solid var(--border); padding: 14px 24px;
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand h1 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill.accent { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .pill.changed { border-color: color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .pill.danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .pill.ok { border-color: color-mix(in srgb, var(--ok) 45%, transparent); color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button, select, input[type="search"] {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 7px; padding: 6px 10px; font-size: 12.5px; font-family: inherit;
  }
  button { cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button:hover { background: var(--surface-2); }
  button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .toolbar {
    padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--surface);
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
  }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  main { padding: 20px 24px 80px; max-width: 1680px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 18px; }
  .feed { display: flex; flex-direction: column; gap: 28px; max-width: 1120px; margin: 0 auto; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden; display: flex; flex-direction: column;
  }
  .card-head {
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  }
  .card-title { margin: 0; font-size: 14px; font-weight: 600; }
  .card-desc { margin: 3px 0 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .stage {
    position: relative; background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 50% / 16px 16px;
    cursor: zoom-in; overflow: hidden; display: flex; align-items: center; justify-content: center;
    min-height: 200px;
  }
  .stage img, .stage video { width: 100%; height: auto; display: block; }
  .compare-bar { display: flex; gap: 4px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface-2); align-items: center; justify-content: space-between; }
  .compare-bar .group { display: flex; gap: 4px; }
  .compare-bar button { padding: 3px 8px; font-size: 11px; }
  .split-wrap { position: relative; width: 100%; user-select: none; }
  .split-wrap img { width: 100%; display: block; }
  .split-before { position: absolute; inset: 0; overflow: hidden; }
  .split-before img { width: 100%; height: 100%; object-fit: cover; object-position: left top; }
  .split-handle { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; box-shadow: 0 0 0 1px rgba(0,0,0,.4); }
  .split-range { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: ew-resize; margin: 0; }
  .sbs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; background: var(--border); width: 100%; }
  .sbs figure { margin: 0; position: relative; }
  .sbs figcaption { position: absolute; top: 8px; left: 8px; font-size: 11px; padding: 2px 6px; border-radius: 5px; background: rgba(0,0,0,.72); color: #fff; }
  .note-box { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; gap: 8px; align-items: center; }
  .note-box input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
  .card-foot { padding: 8px 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sheets { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 20px; }
  .sheets h2 { font-size: 14px; margin: 0 0 12px; }
  .sheet-links { display: flex; flex-wrap: wrap; gap: 8px; }
  .lightbox {
    position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.9);
    display: none; flex-direction: column; padding: 20px;
  }
  .lightbox.open { display: flex; }
  .lb-top { display: flex; justify-content: space-between; align-items: center; color: #fff; margin-bottom: 12px; gap: 12px; }
  .lb-body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: auto; }
  .lb-body img, .lb-body video { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  .lb-body.zoomed img { max-width: none; max-height: none; }
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <h1>Todoflare UI Review Feed</h1>
    <span class="pill accent" id="runName"></span>
    <span class="pill" id="runMeta"></span>
    <a class="pill" href="../index.html">All runs ↗</a>
  </div>
  <div class="controls">
    <input type="search" id="search" placeholder="Filter by title, id, surface..." />
    <select id="themeFilter"><option value="all">All themes</option></select>
    <select id="vpFilter"><option value="all">All viewports</option></select>
    <select id="diffFilter" style="display:none">
      <option value="all">All diffs</option>
      <option value="changed">Changed only</option>
      <option value="new">New only</option>
      <option value="identical">Identical</option>
    </select>
    <button id="layoutBtn">Feed view</button>
    <button id="uiThemeBtn">Light chrome</button>
    <button id="copyBriefBtn" class="active">Copy Hill-Climb Brief (0)</button>
  </div>
</header>

<div class="toolbar">
  <div class="tabs" id="catTabs"></div>
  <div class="controls" id="summaryBadges"></div>
</div>

<main>
  <div id="container" class="grid"></div>
  <section class="sheets" id="sheetsSection" style="display:none">
    <h2>Agent Contact Sheets (one-read category overviews)</h2>
    <div class="sheet-links" id="sheetLinks"></div>
  </section>
</main>

<div class="lightbox" id="lightbox">
  <div class="lb-top">
    <div>
      <strong id="lbTitle"></strong>
      <span class="pill" id="lbSub" style="margin-left:8px"></span>
    </div>
    <div class="controls">
      <button id="lbPrev">← Prev</button>
      <button id="lbNext">Next →</button>
      <button id="lbZoom">1:1 Zoom (Z)</button>
      <button id="lbClose">Close (Esc)</button>
    </div>
  </div>
  <div class="lb-body" id="lbBody"></div>
</div>

<script>
const MANIFEST = ${jsonSafe};
const state = {
  category: 'all',
  theme: 'all',
  viewport: 'all',
  diff: 'all',
  search: '',
  layout: 'grid',
  cardMode: {}, // key -> 'after' | 'before' | 'slider' | 'sbs' | 'diff' | 'video'
  notes: JSON.parse(localStorage.getItem('tf-review-notes:' + MANIFEST.run) || '{}'),
  lbIndex: -1,
  lbZoomed: false,
};

const $ = (id) => document.getElementById(id);
$('runName').textContent = MANIFEST.run + (MANIFEST.compareTo ? ' vs ' + MANIFEST.compareTo : '');
$('runMeta').textContent = MANIFEST.shots.length + ' shots · ' + new Date(MANIFEST.createdAt).toLocaleString();

const themes = [...new Set(MANIFEST.shots.map(s => s.theme))];
themes.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = 'Theme: ' + t; $('themeFilter').appendChild(o); });
const vps = [...new Set(MANIFEST.shots.map(s => s.viewport.name))];
vps.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = 'Viewport: ' + v; $('vpFilter').appendChild(o); });
if (MANIFEST.compareTo) $('diffFilter').style.display = '';

if (MANIFEST.contactSheets?.length) {
  $('sheetsSection').style.display = '';
  MANIFEST.contactSheets.forEach(sh => {
    const a = document.createElement('a');
    a.className = 'pill';
    a.href = sh.path;
    a.target = '_blank';
    a.textContent = sh.category + '.png (' + sh.count + ')';
    $('sheetLinks').appendChild(a);
  });
}

function filteredShots() {
  const q = state.search.trim().toLowerCase();
  return MANIFEST.shots.filter(s => {
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (state.theme !== 'all' && s.theme !== state.theme) return false;
    if (state.viewport !== 'all' && s.viewport.name !== state.viewport) return false;
    if (state.diff !== 'all' && (s.compare?.status ?? 'none') !== state.diff) return false;
    if (q && !(s.title + ' ' + s.id + ' ' + s.surface + ' ' + s.accountConfig + ' ' + s.description).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderTabs() {
  const cats = ['all', ...new Set(MANIFEST.shots.map(s => s.category))];
  $('catTabs').innerHTML = '';
  cats.forEach(c => {
    const count = c === 'all' ? MANIFEST.shots.length : MANIFEST.shots.filter(s => s.category === c).length;
    const b = document.createElement('button');
    b.textContent = c + ' (' + count + ')';
    if (state.category === c) b.className = 'active';
    b.onclick = () => { state.category = c; render(); };
    $('catTabs').appendChild(b);
  });
}

function updateBriefButton() {
  const count = Object.values(state.notes).filter(v => v && v.trim()).length;
  $('copyBriefBtn').textContent = 'Copy Hill-Climb Brief (' + count + ')';
}

function renderStage(shot, mode) {
  const wrap = document.createElement('div');
  wrap.className = 'stage';
  if (mode === 'video' && shot.video) {
    const v = document.createElement('video');
    v.src = shot.video; v.controls = true; v.loop = true; v.muted = true; v.playsInline = true;
    wrap.style.cursor = 'default';
    wrap.appendChild(v);
    return wrap;
  }
  if (mode === 'before' && shot.compare?.baselineImage) {
    const img = document.createElement('img'); img.src = shot.compare.baselineImage; img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }
  if (mode === 'diff' && shot.compare?.diffImage) {
    const img = document.createElement('img'); img.src = shot.compare.diffImage; img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }
  if (mode === 'sbs' && shot.compare?.baselineImage) {
    const grid = document.createElement('div'); grid.className = 'sbs';
    grid.innerHTML = '<figure><figcaption>Before (' + shot.compare.baselineRun + ')</figcaption><img src="' + shot.compare.baselineImage + '" loading="lazy"/></figure>' +
      '<figure><figcaption>After (' + MANIFEST.run + ')</figcaption><img src="' + shot.image + '" loading="lazy"/></figure>';
    wrap.appendChild(grid);
    return wrap;
  }
  if (mode === 'slider' && shot.compare?.baselineImage) {
    const sw = document.createElement('div'); sw.className = 'split-wrap';
    sw.innerHTML = '<img src="' + shot.image + '"/><div class="split-before" style="width:50%"><img src="' + shot.compare.baselineImage + '"/></div><div class="split-handle" style="left:50%"></div><input class="split-range" type="range" min="0" max="100" value="50"/>';
    const range = sw.querySelector('.split-range');
    const before = sw.querySelector('.split-before');
    const handle = sw.querySelector('.split-handle');
    range.oninput = (e) => { e.stopPropagation(); before.style.width = range.value + '%'; handle.style.left = range.value + '%'; };
    range.onclick = (e) => e.stopPropagation();
    wrap.style.cursor = 'ew-resize';
    wrap.appendChild(sw);
    return wrap;
  }
  const img = document.createElement('img'); img.src = shot.image; img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function render() {
  renderTabs();
  updateBriefButton();
  const list = filteredShots();
  const issues = list.filter(s => (s.diagnostics?.consoleErrors?.length || 0) + (s.diagnostics?.pageErrors?.length || 0) + (s.diagnostics?.horizontalOverflowPx || 0) + (s.diagnostics?.clippedPopups?.length || 0) + (s.diagnostics?.edgeHuggingDialogs?.length || 0) + (s.diagnostics?.fixedOverlaps?.length || 0) > 0).length;
  const changed = list.filter(s => s.compare?.status === 'changed').length;
  $('summaryBadges').innerHTML =
    '<span class="pill">Showing ' + list.length + '</span>' +
    (MANIFEST.compareTo ? '<span class="pill changed">' + changed + ' changed</span>' : '') +
    (issues > 0 ? '<span class="pill danger">' + issues + ' diagnostics</span>' : '<span class="pill ok">0 errors</span>');

  const container = $('container');
  container.className = state.layout;
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = '<div class="empty">No captured surfaces match the current filters.</div>';
    return;
  }

  list.forEach((shot, idx) => {
    const mode = state.cardMode[shot.key] || (shot.compare?.status === 'changed' ? 'slider' : 'after');
    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const diagPills = [];
    if (shot.diagnostics?.consoleErrors?.length) diagPills.push('<span class="pill danger">' + shot.diagnostics.consoleErrors.length + ' console err</span>');
    if (shot.diagnostics?.pageErrors?.length) diagPills.push('<span class="pill danger">' + shot.diagnostics.pageErrors.length + ' page err</span>');
    if (shot.diagnostics?.horizontalOverflowPx > 0) diagPills.push('<span class="pill changed">overflow +' + shot.diagnostics.horizontalOverflowPx + 'px</span>');
    if (shot.diagnostics?.clippedPopups?.length) diagPills.push('<span class="pill changed">clipped popup</span>');
    if (shot.diagnostics?.edgeHuggingDialogs?.length) diagPills.push('<span class="pill changed">edge-hugging dialog</span>');
    if (shot.diagnostics?.fixedOverlaps?.length) diagPills.push('<span class="pill danger">fixed overlap</span>');
    if (shot.compare?.status === 'changed') diagPills.push('<span class="pill changed">Δ ' + shot.compare.diffPercent + '%</span>');
    else if (shot.compare?.status === 'identical') diagPills.push('<span class="pill ok">identical</span>');
    else if (shot.compare?.status === 'new') diagPills.push('<span class="pill accent">new</span>');

    head.innerHTML = '<div><h3 class="card-title">' + escapeHtml(shot.title) + '</h3>' +
      (shot.description ? '<p class="card-desc">' + escapeHtml(shot.description) + '</p>' : '') +
      '<div class="badges"><span class="pill">' + shot.category + '</span><span class="pill">' + shot.surface + '</span><span class="pill">' + shot.theme + '</span><span class="pill">' + shot.viewport.width + '×' + shot.viewport.height + '</span><span class="pill">' + escapeHtml(shot.accountConfig) + '</span>' + diagPills.join('') + '</div></div>';
    card.appendChild(head);

    const stage = renderStage(shot, mode);
    if (mode !== 'slider' && mode !== 'video') {
      stage.onclick = () => openLightbox(idx, list);
    }
    card.appendChild(stage);

    if (shot.compare?.baselineImage || shot.video) {
      const bar = document.createElement('div');
      bar.className = 'compare-bar';
      const grp = document.createElement('div'); grp.className = 'group';
      const modes = [];
      if (shot.compare?.baselineImage) modes.push(['after', 'After'], ['before', 'Before'], ['slider', 'Slider'], ['sbs', 'Side-by-Side']);
      if (shot.compare?.diffImage) modes.push(['diff', 'Pixel Diff']);
      if (shot.video) modes.push(['video', 'Flow Video']);
      if (!shot.compare?.baselineImage && shot.video) modes.unshift(['after', 'Still']);
      modes.forEach(([m, lbl]) => {
        const b = document.createElement('button');
        b.textContent = lbl;
        if (mode === m) b.className = 'active';
        b.onclick = () => { state.cardMode[shot.key] = m; render(); };
        grp.appendChild(b);
      });
      bar.appendChild(grp);
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Inspect ⤢';
      openBtn.onclick = () => openLightbox(idx, list);
      bar.appendChild(openBtn);
      card.appendChild(bar);
    }

    const noteBox = document.createElement('div');
    noteBox.className = 'note-box';
    const inp = document.createElement('input');
    inp.placeholder = 'Hill-climb note for this surface...';
    inp.value = state.notes[shot.key] || '';
    inp.oninput = () => {
      state.notes[shot.key] = inp.value;
      localStorage.setItem('tf-review-notes:' + MANIFEST.run, JSON.stringify(state.notes));
      updateBriefButton();
    };
    noteBox.appendChild(inp);
    card.appendChild(noteBox);

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    foot.innerHTML = '<span>' + shot.id + '</span><span>' + shot.image + '</span>';
    card.appendChild(foot);
    container.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let currentLbList = [];
function openLightbox(index, list) {
  currentLbList = list;
  state.lbIndex = index;
  state.lbZoomed = false;
  updateLightbox();
  $('lightbox').classList.add('open');
}
function updateLightbox() {
  const shot = currentLbList[state.lbIndex];
  if (!shot) return;
  $('lbTitle').textContent = shot.title;
  $('lbSub').textContent = shot.id + ' · ' + shot.theme + ' · ' + shot.viewport.width + '×' + shot.viewport.height + (shot.compare?.diffPercent ? ' · Δ' + shot.compare.diffPercent + '%' : '');
  const body = $('lbBody');
  body.className = 'lb-body' + (state.lbZoomed ? ' zoomed' : '');
  body.innerHTML = '';
  const mode = state.cardMode[shot.key] || 'after';
  if (mode === 'video' && shot.video) {
    const v = document.createElement('video'); v.src = shot.video; v.controls = true; v.autoplay = true; v.loop = true;
    body.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = mode === 'before' && shot.compare?.baselineImage ? shot.compare.baselineImage : mode === 'diff' && shot.compare?.diffImage ? shot.compare.diffImage : shot.image;
    body.appendChild(img);
  }
}

$('lbClose').onclick = () => $('lightbox').classList.remove('open');
$('lbPrev').onclick = () => { state.lbIndex = (state.lbIndex - 1 + currentLbList.length) % currentLbList.length; updateLightbox(); };
$('lbNext').onclick = () => { state.lbIndex = (state.lbIndex + 1) % currentLbList.length; updateLightbox(); };
$('lbZoom').onclick = () => { state.lbZoomed = !state.lbZoomed; updateLightbox(); };
document.addEventListener('keydown', (e) => {
  if (!$('lightbox').classList.contains('open')) return;
  if (e.key === 'Escape') $('lightbox').classList.remove('open');
  if (e.key === 'ArrowLeft') $('lbPrev').click();
  if (e.key === 'ArrowRight') $('lbNext').click();
  if (e.key === 'z' || e.key === 'Z') $('lbZoom').click();
});

$('search').oninput = (e) => { state.search = e.target.value; render(); };
$('themeFilter').onchange = (e) => { state.theme = e.target.value; render(); };
$('vpFilter').onchange = (e) => { state.viewport = e.target.value; render(); };
$('diffFilter').onchange = (e) => { state.diff = e.target.value; render(); };
$('layoutBtn').onclick = () => {
  state.layout = state.layout === 'grid' ? 'feed' : 'grid';
  $('layoutBtn').textContent = state.layout === 'grid' ? 'Feed view' : 'Grid view';
  render();
};
$('uiThemeBtn').onclick = () => {
  document.documentElement.classList.toggle('light');
  $('uiThemeBtn').textContent = document.documentElement.classList.contains('light') ? 'Dark chrome' : 'Light chrome';
};
$('copyBriefBtn').onclick = async () => {
  const entries = MANIFEST.shots.filter(s => state.notes[s.key]?.trim());
  const lines = [
    '# Design Hill-Climb Feedback (' + MANIFEST.run + ')',
    '',
    ...(entries.length ? entries.map(s => '- **' + s.id + '** (' + s.theme + ', ' + s.viewport.name + ', \`' + s.image + '\`): ' + state.notes[s.key].trim()) : ['No notes added yet — type notes under any card first.']),
  ];
  await navigator.clipboard.writeText(lines.join('\\n'));
  const orig = $('copyBriefBtn').textContent;
  $('copyBriefBtn').textContent = 'Copied!';
  setTimeout(() => ($('copyBriefBtn').textContent = orig), 1500);
};

render();
</script>
</body>
</html>`;
	fs.writeFileSync(path.join(runDir, "index.html"), html, "utf8");
}

/** Updates `.design-review/index.html` with every hill-climb run newest-first. */
export function writeRunsIndexHtml(outRoot) {
	const runs = [];
	if (fs.existsSync(outRoot)) {
		for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const mpath = path.join(outRoot, entry.name, "manifest.json");
			if (!fs.existsSync(mpath)) continue;
			try {
				const m = JSON.parse(fs.readFileSync(mpath, "utf8"));
				runs.push({
					run: entry.name,
					createdAt: m.createdAt ?? "",
					shots: m.shots?.length ?? 0,
					compareTo: m.compareTo ?? null,
					changed: (m.shots ?? []).filter((s) => s.compare?.status === "changed").length,
					themes: m.themes ?? [],
					viewports: (m.viewports ?? []).map((v) => v.name ?? v),
					gitCommit: m.gitCommit ?? "",
				});
			} catch {
				// Ignore partial/invalid directories.
			}
		}
	}
	runs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Todoflare Design Hill-Climb Runs</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: #0c0c0e; color: #f4f4f5; padding: 36px 24px; }
  main { max-width: 920px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 0 0 24px; color: #a1a1aa; font-size: 14px; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  a.row {
    display: flex; justify-content: space-between; align-items: center; gap: 16px;
    padding: 14px 16px; border-radius: 10px; border: 1px solid #27272f; background: #141418;
    text-decoration: none; color: inherit;
  }
  a.row:hover { border-color: #3b82f6; background: #18181f; }
  .title { font-weight: 600; font-size: 15px; }
  .meta { font-size: 12px; color: #a1a1aa; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid #27272f; background: #1c1c22; color: #d4d4d8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Todoflare Design Hill-Climb Runs</h1>
  <p>Automated UI capture feeds generated by <code>pnpm capture:ui</code>.</p>
  <div class="list">
    ${runs
		.map(
			(r) => `<a class="row" href="./${encodeURIComponent(r.run)}/index.html">
      <div>
        <div class="title">${escapeHtml(r.run)}${r.compareTo ? ` <span class="pill">vs ${escapeHtml(r.compareTo)} · ${r.changed} changed</span>` : ""}</div>
        <div class="meta">${r.shots} shots · themes: ${r.themes.join(", ")} · viewports: ${r.viewports.join(", ")}${r.gitCommit ? ` · ${r.gitCommit}` : ""}</div>
      </div>
      <span class="pill">${r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</span>
    </a>`,
		)
		.join("\n")}
  </div>
</main>
</body>
</html>`;
	fs.writeFileSync(path.join(outRoot, "index.html"), html, "utf8");
}

function escapeHtml(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
