#!/usr/bin/env node
// Renders the social preview: public/og.png (1200×630) and public/og.mp4
// (1200×630, 60 fps, 300 frames, seamless loop).
//
// "Two Strokes": the checkmark in the Todoflare icon splits at its vertex into
// two live threads, You (ink) and Agent (brand blue). They weave across a
// three-column board, the Private column's divider refuses the Agent and lets
// You through, then both threads reel back into the icon and the board folds
// into the still card again. Frame 0 is the og:image.
//
// Every frame is drawn deterministically on a 2400×1260 canvas in Chromium
// (Playwright), read back as raw RGBA and piped to ffmpeg, which downsamples
// with Lanczos. Nothing depends on wall-clock time or Math.random().
//
// Usage:
//   node scripts/generate-og.mjs [--qa <dir>] [--crf 19] [--preview 0,120,233] [--bench]
//
// --qa writes a labelled contact sheet, small thumbnails and the frame 0 vs
// frame 300 SSIM check into <dir>. --preview renders only the listed frames as
// PNGs into the QA dir (or the system temp dir) and skips the video.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PNG = path.join(ROOT, 'public', 'og.png');
const OUT_MP4 = path.join(ROOT, 'public', 'og.mp4');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const FONT_DIRS = ['/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')];
const W = 2400;
const H = 1260;
const FRAMES = 300;
const MAX_MP4_BYTES = 1.2 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
	const out = { qa: null, crf: null, preview: null, bench: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--qa') out.qa = path.resolve(argv[++i]);
		else if (a === '--crf') out.crf = Number(argv[++i]);
		else if (a === '--preview') out.preview = argv[++i].split(',').map(Number);
		else if (a === '--bench') out.bench = true;
		else throw new Error(`Unknown argument: ${a}`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Everything below `renderer` runs inside Chromium. It must be self-contained.
// ---------------------------------------------------------------------------

function renderer() {
	const W = 1200;
	const H = 630;
	const SS = 2;
	const FPS = 60;
	const STACK = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
	const F = (weight, px) => `${weight} ${px}px ${STACK}`;

	// Palette: tokens.css (light) plus the dark-mode brand for inside the icon.
	const C = {
		ink: '#141416',
		text: '#18181b',
		done: '#8e8e93',
		tagline: '#4a4a4f',
		blue: '#2563eb',
		blueDark: '#60a5fa',
		sky: '#38bdf8',
		porcelain: '#f8f8f9',
	};
	const HIGHLIGHT = 'rgba(250, 204, 21, 0.40)';

	// Timeline (seconds). The loop is 5.00 s; everything is at rest from T_REST.
	const T_UN = 1.02; // the checkmark splits
	const T_RB = 195 / FPS; // reel-back starts (3.25 s)
	const T_SNAP = 230 / FPS; // both threads hit the vertex (3.833 s)
	const T_CURSOR_OUT = 3.14;

	// ---------------------------------------------------------------- math --
	const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
	const lerp = (a, b, t) => a + (b - a) * t;
	const seg = (t, a, b) => clamp((t - a) / (b - a));
	const smooth = (x) => x * x * (3 - 2 * x);
	const eIn = (x) => x * x * x;
	const eOut = (x) => 1 - (1 - x) ** 3;
	const eInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
	const eOutBack = (x, s = 1.3) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2);
	function cubicBezier(x1, y1, x2, y2) {
		const bx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
		const by = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
		return (x) => {
			if (x <= 0) return 0;
			if (x >= 1) return 1;
			let lo = 0;
			let hi = 1;
			for (let i = 0; i < 32; i++) {
				const m = (lo + hi) / 2;
				if (bx(m) < x) lo = m;
				else hi = m;
			}
			return by((lo + hi) / 2);
		};
	}
	const eMorph = cubicBezier(0.7, 0, 0.16, 1);

	const P = (x, y) => ({ x, y });
	const sub = (a, b) => P(a.x - b.x, a.y - b.y);
	const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const norm = (a) => {
		const l = Math.hypot(a.x, a.y) || 1;
		return P(a.x / l, a.y / l);
	};
	const dirDeg = (d) => P(Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180));
	const angDeg = (v) => (Math.atan2(v.y, v.x) * 180) / Math.PI;

	function hexRgb(hex) {
		const n = parseInt(hex.slice(1), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	function mix(a, b, t) {
		const A = hexRgb(a);
		const B = hexRgb(b);
		const q = Math.round(clamp(t) * 32) / 32;
		return `rgb(${Math.round(lerp(A[0], B[0], q))},${Math.round(lerp(A[1], B[1], q))},${Math.round(lerp(A[2], B[2], q))})`;
	}
	function mulberry32(seed) {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// ------------------------------------------------------------ canvases --
	const makeCanvas = () => {
		const c = document.createElement('canvas');
		c.width = W * SS;
		c.height = H * SS;
		return c;
	};
	const stage = document.getElementById('stage');
	stage.width = W * SS;
	stage.height = H * SS;
	const opts = { willReadFrequently: true };
	const ctx = stage.getContext('2d', { ...opts, alpha: false });
	const bgC = makeCanvas();
	const inC = makeCanvas();
	const outC = makeCanvas();
	const tmpC = makeCanvas();
	const inX = inC.getContext('2d', opts);
	const outX = outC.getContext('2d', opts);
	const tmpX = tmpC.getContext('2d', opts);
	for (const c of [ctx, inX, outX, tmpX]) {
		c.textRendering = 'geometricPrecision';
		c.fontKerning = 'normal';
		c.imageSmoothingQuality = 'high';
	}

	// ---------------------------------------------------------------- icon --
	// The icon is drawn in its own 256-unit space, measured from
	// public/todoflare-icon.png. On the hero card (p=0) it sits at 268×268
	// centred on (308, 315) so the lockup is optically centred; as the board
	// opens (p→1) it glides smoothly left to 240×240 centred on (202, 315).
	const HERO_ICX = 308;
	const HERO_ICY = 315;
	const HERO_SIZE = 268;
	const ICX = 202;
	const ICY = 315;
	const BOARD_SIZE = 240;
	const IC = { x: ICX - BOARD_SIZE / 2, y: ICY - BOARD_SIZE / 2, s: BOARD_SIZE / 256 };
	const ip = (u, v) => P(IC.x + u * IC.s, IC.y + v * IC.s);
	const VTX = ip(119.5, 154);
	const E_SHORT = ip(95, 130);
	const E_LONG = ip(164, 105);
	const THICK = 16 * IC.s;
	const THIN = 4.2;
	const STRIKE = 2.2;
	const toIcon = (p) => P((p.x - IC.x) / IC.s, (p.y - IC.y) / IC.s);
	function sdRoundRect(p, cx, cy, hw, hh, r) {
		const qx = Math.abs(p.x - cx) - (hw - r);
		const qy = Math.abs(p.y - cy) - (hh - r);
		return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
	}
	const squircleSD = (p) => sdRoundRect(toIcon(p), 128, 128, 128, 128, 56);
	const ringSD = (p) => sdRoundRect(toIcon(p), 128, 128, 64, 64, 24);
	const squirclePath = (c) => {
		c.beginPath();
		c.roundRect(IC.x, IC.y, 256 * IC.s, 256 * IC.s, 56 * IC.s);
	};

	// --------------------------------------------------------------- board --
	const ROW0 = 210;
	const ROWH = 58;
	const BOX = 24;
	const COLS = [
		{ left: 420, right: 740, x: 454, title: 'Todoflare', rows: ['Write changelog', 'Record demo', 'Ship og:image'], indent: [0, 0, 0] },
		{ left: 740, right: 1020, x: 768, title: 'Groceries', rows: ['Milk', 'Bread', 'Sourdough'], indent: [0, 0, 30] },
		{ left: 1020, right: 1300, x: 1048, title: 'Private', rows: ['Call mom', 'Taxes'], indent: [0, 0] },
	];
	const RULES = [420, 740, 1020];
	const DIVIDER = 1020;
	const WALL = DIVIDER - 2.4; // a 4.2px thread touching the divider
	const OMEGA = 2 * Math.PI * 8.5; // plucked-string frequency
	const DAMP = 9.5;
	const BOW = 32;
	const BOW_SIGMA = 48;

	let G = null; // geometry, built once fonts are ready

	// ------------------------------------------------------- path builder --
	// Waypoints {x, y, a?, ain?, aout?, k?} joined by cubic Hermite segments.
	// Two waypoints whose tangents both follow the chord give a straight
	// segment, which is what makes a thread a clean strikethrough.
	function buildPath(wps) {
		const n = wps.length;
		const pts = wps.map((w) => P(w.x, w.y));
		const tin = [];
		const tout = [];
		for (let i = 0; i < n; i++) {
			const w = wps[i];
			const auto =
				i === 0 ? norm(sub(pts[1], pts[0])) : i === n - 1 ? norm(sub(pts[n - 1], pts[n - 2])) : norm(sub(pts[i + 1], pts[i - 1]));
			tin.push(w.ain != null ? dirDeg(w.ain) : w.a != null ? dirDeg(w.a) : auto);
			tout.push(w.aout != null ? dirDeg(w.aout) : w.a != null ? dirDeg(w.a) : auto);
		}
		const xs = [pts[0].x];
		const ys = [pts[0].y];
		const wpIndex = [0];
		for (let i = 0; i < n - 1; i++) {
			const p0 = pts[i];
			const p1 = pts[i + 1];
			const L = dist(p0, p1);
			const m0 = P(tout[i].x * L * (wps[i].k ?? 1), tout[i].y * L * (wps[i].k ?? 1));
			const m1 = P(tin[i + 1].x * L * (wps[i + 1].k ?? 1), tin[i + 1].y * L * (wps[i + 1].k ?? 1));
			const N = Math.max(2, Math.ceil(L * 1.6));
			for (let j = 1; j <= N; j++) {
				const u = j / N;
				const u2 = u * u;
				const u3 = u2 * u;
				const h00 = 2 * u3 - 3 * u2 + 1;
				const h10 = u3 - 2 * u2 + u;
				const h01 = -2 * u3 + 3 * u2;
				const h11 = u3 - u2;
				xs.push(h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x);
				ys.push(h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y);
			}
			wpIndex.push(xs.length - 1);
		}
		const s = new Float64Array(xs.length);
		for (let i = 1; i < xs.length; i++) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
		const ids = {};
		wps.forEach((w, i) => {
			if (w.id) ids[w.id] = s[wpIndex[i]];
		});
		return { xs, ys, s, n: xs.length, wpS: wpIndex.map((i) => s[i]), ids, total: s[xs.length - 1] };
	}
	function idxAt(path, sv) {
		let lo = 0;
		let hi = path.n - 1;
		while (hi - lo > 1) {
			const m = (lo + hi) >> 1;
			if (path.s[m] <= sv) lo = m;
			else hi = m;
		}
		return lo;
	}
	function pointAt(path, sv) {
		const v = clamp(sv, 0, path.total);
		const i = idxAt(path, v);
		const j = Math.min(i + 1, path.n - 1);
		const span = path.s[j] - path.s[i] || 1;
		const u = clamp((v - path.s[i]) / span);
		return P(lerp(path.xs[i], path.xs[j], u), lerp(path.ys[i], path.ys[j], u));
	}
	// First s in [s0, s1] where pred(point) flips to true.
	function findS(path, s0, s1, pred) {
		const i0 = idxAt(path, s0);
		const i1 = idxAt(path, s1);
		for (let i = i0; i <= i1; i++) if (pred(path.xs[i], path.ys[i])) return path.s[i];
		return s1;
	}
	function sAtX(path, s0, s1, x) {
		const dir = pointAt(path, s1).x > pointAt(path, s0).x ? 1 : -1;
		let lo = s0;
		let hi = s1;
		for (let i = 0; i < 40; i++) {
			const m = (lo + hi) / 2;
			if ((pointAt(path, m).x - x) * dir < 0) lo = m;
			else hi = m;
		}
		return (lo + hi) / 2;
	}

	// Monotone cubic timing through {t, s, stop?, v?} keyframes.
	function makeTiming(keys) {
		const n = keys.length;
		const T = keys.map((k) => k.t);
		const S = keys.map((k) => k.s);
		const d = [];
		for (let i = 0; i < n - 1; i++) d.push((S[i + 1] - S[i]) / (T[i + 1] - T[i]));
		const m = keys.map((k, i) => {
			if (k.v != null) return k.v;
			if (k.stop || i === 0 || i === n - 1) return 0;
			const d0 = d[i - 1];
			const d1 = d[i];
			if (d0 <= 0 || d1 <= 0) return 0;
			const h0 = T[i] - T[i - 1];
			const h1 = T[i + 1] - T[i];
			const w1 = 2 * h1 + h0;
			const w2 = h1 + 2 * h0;
			return (w1 + w2) / (w1 / d0 + w2 / d1);
		});
		const fn = (t) => {
			if (t <= T[0]) return S[0];
			if (t >= T[n - 1]) return S[n - 1];
			let i = 0;
			while (t > T[i + 1]) i++;
			const h = T[i + 1] - T[i];
			const u = (t - T[i]) / h;
			const u2 = u * u;
			const u3 = u2 * u;
			return (2 * u3 - 3 * u2 + 1) * S[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * S[i + 1] + (u3 - u2) * h * m[i + 1];
		};
		fn.t0 = T[0];
		fn.t1 = T[n - 1];
		return fn;
	}
	function invert(fn, target, t0, t1) {
		let lo = t0;
		let hi = t1;
		for (let i = 0; i < 48; i++) {
			const m = (lo + hi) / 2;
			if (fn(m) < target) lo = m;
			else hi = m;
		}
		return (lo + hi) / 2;
	}

	// ------------------------------------------------------------ geometry --
	function build() {
		ctx.save();
		ctx.font = F(500, 22);
		ctx.letterSpacing = '0px';
		const xh = ctx.measureText('x').actualBoundingBoxAscent;
		const capH = ctx.measureText('H').actualBoundingBoxAscent;
		const rows = [];
		COLS.forEach((col, ci) =>
			col.rows.forEach((label, ri) => {
				const y = ROW0 + ROWH * ri;
				const boxX = col.x + col.indent[ri];
				const textX = boxX + BOX + 14;
				const w = ctx.measureText(label).width;
				const base = y + capH / 2;
				rows.push({ ci, ri, label, y, boxX, textX, w, end: textX + w, base, strike: base - xh / 2, idx: rows.length });
			}),
		);
		ctx.font = F(700, 38);
		ctx.letterSpacing = `${-0.03 * 38}px`;
		const privateW = ctx.measureText('Private').width;
		const headCap = ctx.measureText('P').actualBoundingBoxAscent;
		ctx.font = F(800, 114);
		ctx.letterSpacing = '0px';
		const kernTo = ctx.measureText('To').width - ctx.measureText('T').width - ctx.measureText('o').width;
		ctx.restore();
		const R = (ci, ri) => rows.find((r) => r.ci === ci && r.ri === ri);

		const sy0 = R(0, 0).strike;
		const sy1 = R(0, 1).strike;
		const sy2 = R(1, 2).strike;
		const lane1 = (sy0 + sy1) / 2;
		const lane2 = (sy1 + sy2) / 2;
		const LANE0 = 176;
		const IMPACT_Y = sy2; // Agent charges straight from Sourdough into Private
		const U = 1.17; // quarter-circle Hermite tangent factor

		// You: the short stroke. Exits upward-right through the top edge of the
		// icon (never traveling backward!) in one sleek calligraphic S-curve into
		// Write changelog, stitches Record demo with a rhyming hairpin, weaves
		// cleanly over Agent in the 740 gutter, then AFTER Agent's Private bounce
		// glides effortlessly straight through the Private divider to Call mom.
		const aS = angDeg(sub(E_SHORT, VTX));
		const wc = R(0, 0);
		const rd = R(0, 1);
		const cm = R(2, 0);
		const youW = [
			{ ...VTX, a: aS },
			{ ...E_SHORT, a: aS },
			{ x: ip(110, 62).x, y: ip(110, 62).y, a: -42 },
			{ x: ip(162, -6).x, y: ip(162, -6).y, a: -18, id: 'out' },
			{ x: 324, y: 170, a: 8 },
			{ x: 422, y: sy0, a: 0 },
			{ x: wc.textX - 7, y: sy0, a: 0 },
			{ x: wc.end + 7, y: sy0, a: 0, k: U },
			{ x: wc.end + 7 + (lane1 - sy0) / 2, y: (sy0 + lane1) / 2, a: 90, k: U },
			{ x: wc.end + 7, y: lane1, a: 180, k: U },
			{ x: 450, y: lane1, a: 180, k: U },
			{ x: 450 - (sy1 - lane1) / 2, y: (lane1 + sy1) / 2, a: 90, k: U },
			{ x: 450, y: sy1, a: 0, k: U },
			{ x: rd.textX - 7, y: sy1, a: 0 },
			{ x: rd.end + 7, y: sy1, a: 0 },
			{ x: 702, y: 244 },
			{ x: 742, y: 196 },
			{ x: 794, y: LANE0, a: 0 },
			{ x: 944, y: LANE0, a: 0, id: 'waitPass' },
			{ x: 998, y: sy0, a: 0 },
			{ x: 1034, y: sy0, a: 0, id: 'through' },
			{ x: cm.textX - 7, y: sy0, a: 0 },
			{ x: cm.end + 7, y: sy0, a: 0 },
			{ x: cm.end + 18, y: sy0, a: 0, id: 'rest' },
		];
		const youT = [1.02, 1.1, 1.18, 1.28, 1.4, 1.44, 1.59, 1.62, 1.65, 1.73, 1.76, 1.79, 1.83, 1.98, 2.09, 2.18, 2.3, 2.66, 2.82, 2.88, 2.93, 3.06, 3.12];

		// Agent: the long stroke. Leaves naturally up-right through the icon's
		// right-upper edge, sails cleanly under the Todoflare title into Groceries,
		// checks Milk -> Bread -> Sourdough using identical rhyming hairpins, then
		// charges straight at the Private divider, bows it 32px, and recoils back
		// along its own horizontal track (no V-kink, no bottom lasso).
		const aL = angDeg(sub(E_LONG, VTX));
		const dL = norm(sub(E_LONG, VTX));
		const mk = R(1, 0);
		const br = R(1, 1);
		const sd = R(1, 2);
		const agentW = [
			{ ...VTX, a: aL },
			{ ...E_LONG, a: aL },
			{ x: E_LONG.x + dL.x * 116 * IC.s, y: E_LONG.y + dL.y * 116 * IC.s, a: aL, id: 'out' },
			{ x: 378, y: LANE0, a: 0 },
			{ x: 684, y: LANE0, a: 0 },
			{ x: 754, y: sy0, a: 0 },
			{ x: mk.textX - 7, y: sy0, a: 0 },
			{ x: mk.end + 7, y: sy0, a: 0, k: U },
			{ x: mk.end + 7 + (lane1 - sy0) / 2, y: (sy0 + lane1) / 2, a: 90, k: U },
			{ x: mk.end + 7, y: lane1, a: 180, k: U },
			{ x: 762, y: lane1, a: 180, k: U },
			{ x: 762 - (sy1 - lane1) / 2, y: (lane1 + sy1) / 2, a: 90, k: U },
			{ x: 762, y: sy1, a: 0, k: U },
			{ x: br.textX - 7, y: sy1, a: 0 },
			{ x: br.end + 7, y: sy1, a: 0, k: U },
			{ x: br.end + 7 + (lane2 - sy1) / 2, y: (sy1 + lane2) / 2, a: 90, k: U },
			{ x: br.end + 7, y: lane2, a: 180, k: U },
			{ x: 792, y: lane2, a: 180, k: U },
			{ x: 792 - (sy2 - lane2) / 2, y: (lane2 + sy2) / 2, a: 90, k: U },
			{ x: 792, y: sy2, a: 0, k: U },
			{ x: sd.textX - 7, y: sy2, a: 0 },
			{ x: sd.end + 7, y: sy2, a: 0 },
			{ x: 960, y: IMPACT_Y, a: 0, id: 'pullback' },
			{ x: WALL, y: IMPACT_Y, a: 0, id: 'contact' },
			{ x: WALL + BOW, y: IMPACT_Y, a: 0, id: 'apex' },
		];
		const T_APEX = 2.52;
		const T_RECOIL_END = 2.74;
		const agentT = [
			1.02, 1.12, 1.24, 1.44, 1.5, 1.54, 1.65, 1.68, 1.71, 1.78, 1.81, 1.84, 1.87, 1.98, 2.01, 2.04, 2.1, 2.13, 2.16, 2.19, 2.31, 2.36, 2.43, T_APEX,
		];

		const you = makeThread('you', youW, youT, { hold: { id: 'waitPass', until: 2.74 } });
		const agent = makeThread('agent', agentW, agentT, {
			recoil: { apexT: T_APEX, endT: T_RECOIL_END, backId: 'pullback' },
		});

		// Strike intervals, check and mute times for every threaded row.
		function bindRow(th, row, dir) {
			const p = th.path;
			const a = row.textX - 5;
			const b = row.end + 5;
			// The row's straight run: the samples within a pixel of its strike line.
			const onRow = (x, y) => Math.abs(y - row.strike) < 0.6 && x > row.boxX - 12 && x < row.end + 12;
			let first = -1;
			for (let i = 0; i < p.n; i++) {
				if (onRow(p.xs[i], p.ys[i])) {
					first = i;
					break;
				}
			}
			const sFirst = p.s[first];
			const span = row.end + 12 - (row.boxX - 12);
			const sLast = sFirst + span + 4;
			const sA = sAtX(p, sFirst, sLast, dir > 0 ? a : b);
			const sB = sAtX(p, sFirst, sLast, dir > 0 ? b : a);
			const sBox = sAtX(p, sFirst, sLast, row.boxX + BOX / 2);
			const sMid = sAtX(p, sFirst, sLast, row.textX + row.w / 2);
			th.strikes.push([Math.min(sA, sB), Math.max(sA, sB)]);
			row.who = th.key;
			row.color = th.key === 'you' ? C.ink : C.blue;
			row.sBox = sBox;
			row.checkT = th.timeAt(sBox);
			row.muteT = th.timeAt(sMid) - 0.02;
			row.collapseT = th.reelTimeAt(sBox);
		}
		bindRow(you, wc, 1);
		bindRow(you, rd, 1);
		bindRow(you, cm, 1);
		bindRow(agent, mk, 1);
		bindRow(agent, br, 1);
		bindRow(agent, sd, 1);
		you.finishWidths();
		agent.finishWidths();

		G = {
			rows,
			R,
			you,
			agent,
			privateW,
			headCap,
			kernTo,
			impactY: IMPACT_Y,
			tApex: T_APEX,
			tContact: agent.timeAt(agent.path.ids.contact),
			crossings: findCrossings(you.path, agent.path),
		};
		return {
			kernTo,
			privateW,
			crossings: G.crossings.map((c) => [Math.round(c.x), Math.round(c.y), c.upper]),
			checks: rows.filter((r) => r.who).map((r) => [r.label, +r.checkT.toFixed(3), +r.collapseT.toFixed(3)]),
			exits: [+you.tExit.toFixed(3), +agent.tExit.toFixed(3)],
			lengths: [Math.round(you.path.total), Math.round(agent.path.total)],
		};
	}

	function makeThread(key, wps, times, opt) {
		const path = buildPath(wps);
		const L = dist(wps[0], wps[1]);
		const keys = [];
		times.forEach((t, i) => {
			const s = path.wpS[i + 1];
			keys.push({ t, s, stop: i === 0 || i === times.length - 1 });
			if (opt.hold && wps[i + 1].id === opt.hold.id) {
				keys[keys.length - 1].stop = true;
				keys.push({ t: opt.hold.until, s, stop: true });
			}
		});
		const timing = makeTiming(keys);
		const recoil = opt.recoil
			? { t0: opt.recoil.apexT, t1: opt.recoil.endT, sApex: path.ids.apex, sBack: path.ids[opt.recoil.backId] }
			: null;
		const sEnd = recoil ? recoil.sBack : path.wpS[path.wpS.length - 1];

		const headBoard = (t) => {
			if (recoil && t > recoil.t0) {
				if (t >= recoil.t1) return recoil.sBack;
				// Reverse-retract smoothly along its own horizontal track.
				const u = (t - recoil.t0) / (recoil.t1 - recoil.t0);
				return lerp(recoil.sApex, recoil.sBack, eOut(u));
			}
			return timing(t);
		};

		// Where the path dives under the raised checkbox ring, and where it
		// leaves the squircle. The tail rests under the ring: the well is empty.
		const sRingIn = findS(path, L, path.total, (x, y) => Math.abs(ringSD(P(x, y))) <= 8);
		const sRingOut = findS(path, sRingIn, path.total, (x, y) => Math.abs(ringSD(P(x, y))) > 8);
		const sExit = findS(path, sRingOut, path.total, (x, y) => squircleSD(P(x, y)) > 0);
		const anchor = (sRingIn + sRingOut) / 2;

		const th = {
			key,
			path,
			L,
			sEnd,
			anchor,
			sRingIn,
			sRingOut,
			sExit,
			strikes: [],
			width: null,
			head(t) {
				if (t <= T_UN) return L;
				if (t < T_RB) return headBoard(t);
				if (t < T_SNAP) {
					const u = (t - T_RB) / (T_SNAP - T_RB);
					return L + (sEnd - L) * (1 - u ** 2.4);
				}
				return L;
			},
			tail(t) {
				if (t <= T_UN) return 0;
				if (t < T_RB) return anchor * eInOut(seg(t, T_UN, T_UN + 0.25));
				if (t < T_SNAP) {
					const u = (t - T_RB) / (T_SNAP - T_RB);
					return anchor * (1 - seg(u, 0.72, 1) ** 2);
				}
				return 0;
			},
			timeAt(sv) {
				return invert(timing, sv, T_UN, timing.t1);
			},
			reelTimeAt(sv) {
				const u = (1 - clamp((sv - L) / (sEnd - L))) ** (1 / 2.4);
				return T_RB + u * (T_SNAP - T_RB);
			},
			finishWidths() {
				const w = new Float32Array(path.n);
				const taper = 12;
				for (let i = 0; i < path.n; i++) {
					const sv = path.s[i];
					// Thick checkmark stroke in the well, drawn down to a thread
					// while it passes under the ring.
					const inWell = 1 - smooth(seg(sv, sRingIn + 1.5, sRingOut - 2.5));
					let v = lerp(THIN, THICK, inWell);
					for (const [a, b] of th.strikes) {
						const m = sv < a ? 1 - seg(sv, a - taper, a) : sv > b ? seg(sv, b, b + taper) : 0;
						v = lerp(v, STRIKE, smooth(1 - m) * (sv > a - taper && sv < b + taper ? 1 : 0));
					}
					w[i] = v;
				}
				th.width = w;
			},
		};
		th.tExit = th.timeAt(sExit);
		return th;
	}

	function findCrossings(a, b) {
		const out = [];
		const step = 2;
		const outside = (x, y) => squircleSD(P(x, y)) > 6;
		for (let i = 0; i + step < a.n; i += step) {
			const ax0 = a.xs[i];
			const ay0 = a.ys[i];
			const ax1 = a.xs[i + step];
			const ay1 = a.ys[i + step];
			if (!outside(ax0, ay0)) continue;
			for (let j = 0; j + step < b.n; j += step) {
				const bx0 = b.xs[j];
				const by0 = b.ys[j];
				const bx1 = b.xs[j + step];
				const by1 = b.ys[j + step];
				if (Math.max(bx0, bx1) < Math.min(ax0, ax1) || Math.min(bx0, bx1) > Math.max(ax0, ax1)) continue;
				if (Math.max(by0, by1) < Math.min(ay0, ay1) || Math.min(by0, by1) > Math.max(ay0, ay1)) continue;
				const d = (ax1 - ax0) * (by1 - by0) - (ay1 - ay0) * (bx1 - bx0);
				if (Math.abs(d) < 1e-9) continue;
				const u = ((bx0 - ax0) * (by1 - by0) - (by0 - ay0) * (bx1 - bx0)) / d;
				const v = ((bx0 - ax0) * (ay1 - ay0) - (by0 - ay0) * (ax1 - ax0)) / d;
				if (u < 0 || u > 1 || v < 0 || v > 1) continue;
				const x = ax0 + u * (ax1 - ax0);
				const y = ay0 + u * (ay1 - ay0);
				if (out.some((c) => Math.hypot(c.x - x, c.y - y) < 8)) continue;
				out.push({ x, y, sY: lerp(a.s[i], a.s[i + step], u), sA: lerp(b.s[j], b.s[j + step], v) });
			}
		}
		out.sort((p, q) => p.x - q.x);
		// Woven: the threads alternate over and under.
		out.forEach((c, i) => {
			c.upper = i % 2 === 0 ? 'agent' : 'you';
		});
		return out;
	}

	// ------------------------------------------------------------- string --
	function bumpShape(y) {
		// Smooth Gaussian bow (sigma ~48px) so the 32px divider dent reads clearly.
		const dy = y - G.impactY;
		if (Math.abs(dy) >= BOW_SIGMA * 3.6) return 0;
		return Math.exp(-0.5 * (dy / BOW_SIGMA) ** 2);
	}
	function stringA(t) {
		if (t < G.tContact - 0.001) return 0;
		if (t <= G.tApex) return Math.max(0, pointAt(G.agent.path, G.agent.head(t)).x - WALL);
		const dt = t - G.tApex;
		if (dt > 0.65) return 0;
		return BOW * Math.exp(-DAMP * dt) * Math.cos(OMEGA * dt);
	}
	const stringX = (y, A) => DIVIDER + A * bumpShape(y);

	// ------------------------------------------------------------- state --
	function wordmarkP(t) {
		if (t < 3.5) return eMorph(seg(t, 0.42, 0.96));
		return 1 - eOutBack(seg(t, 4.08, 4.64), 1.15);
	}
	function state(t, tt) {
		const st = { t, tt };
		st.p = wordmarkP(t);
		const tagOut = eIn(seg(t, 0.42, 0.58));
		const tagIn = eOut(seg(t, 4.38, 4.72));
		st.tagA = t < 3 ? 1 - tagOut : tagIn;
		st.tagDy = t < 3 ? -8 * tagOut : 8 * (1 - tagIn);
		st.rule = RULES.map((_, c) =>
			t < 3 ? eInOut(seg(t, 0.48 + 0.04 * c, 0.92 + 0.04 * c)) : 1 - eInOut(seg(t, 4.08 + 0.04 * (2 - c), 4.46 + 0.04 * (2 - c))),
		);
		st.chrome = t < 3 ? smooth(seg(t, 0.56, 0.84)) : 1 - smooth(seg(t, 4.04, 4.32));
		// Dim the remaining board to 40% during the Flare so the leftovers read as a quiet wink.
		st.boardDim = 1 - 0.6 * smooth(seg(t, T_SNAP - 0.08, T_SNAP + 0.04));
		st.heads = [1, 2].map((c) => {
			const a = t < 3 ? smooth(seg(t, 0.66 + 0.06 * (c - 1), 0.92 + 0.06 * (c - 1))) : 1 - smooth(seg(t, 4.02 + 0.04 * (c - 1), 4.28 + 0.04 * (c - 1)));
			const dy = t < 3 ? 10 * (1 - a) : 6 * (1 - a);
			return { a: a * (t > 3.5 ? st.boardDim : 1), dy };
		});
		// Hero lockup glides the icon from optical centre (308,315 @268px) to board side (202,315 @240px).
		const pc = clamp(st.p);
		st.icx = lerp(HERO_ICX, ICX, pc);
		st.icy = lerp(HERO_ICY, ICY, pc);
		st.iconMorphScale = lerp(HERO_SIZE / BOARD_SIZE, 1, pc);
		st.iconScale = iconScale(t);
		st.iconLift = iconLift(t);
		st.A = stringA(t);
		// Rows: appear, collapse smoothly as threads reel past, fade at the end.
		st.rows = [];
		for (const col of COLS.keys()) {
			let shift = 0;
			for (const r of G.rows.filter((q) => q.ci === col)) {
				const appear = eOut(seg(t, 0.64 + r.idx * 0.026, 0.88 + r.idx * 0.026));
				const pres = r.collapseT != null ? 1 - eInOut(seg(t, r.collapseT - 0.05, r.collapseT + 0.08)) : 1;
				const fade = r.who ? 0 : smooth(seg(t, 4.02 + 0.03 * col, 4.28 + 0.03 * col));
				const dim = t > 3.5 ? st.boardDim : 1;
				st.rows[r.idx] = { y: r.y - shift + 10 * (1 - appear), alpha: appear * (1 - fade) * pres ** 1.5 * dim, sy: Math.max(pres, 0.001) };
				shift += ROWH * (1 - pres);
			}
		}
		st.you = { sT: G.you.tail(tt), sH: G.you.head(tt) };
		st.agent = { sT: G.agent.tail(tt), sH: G.agent.head(tt) };
		return st;
	}
	function iconScale(t) {
		const d = t - T_SNAP;
		if (d < 0 || d >= 0.56) return 1;
		// Crisp pop: 1 → 0.96 → 1.06 → 0.99 → 1 over ~16 frames, then rest.
		if (d < 0.04) return lerp(1, 0.96, eOut(d / 0.04));
		if (d < 0.14) return lerp(0.96, 1.06, eInOut((d - 0.04) / 0.1));
		if (d < 0.26) return lerp(1.06, 0.99, eInOut((d - 0.14) / 0.12));
		return lerp(0.99, 1, eOut((d - 0.26) / 0.14));
	}
	function iconLift(t) {
		const d = t - T_SNAP;
		if (d < 0 || d >= 0.45) return 0;
		return Math.sin(Math.PI * clamp(d / 0.34)) * Math.exp(-d * 3.5);
	}

	// ----------------------------------------------------------- drawing --
	function bakeBackground() {
		const b = bgC.getContext('2d', opts);
		b.setTransform(SS, 0, 0, SS, 0, 0);
		const g = b.createRadialGradient(W * 0.38, H * 0.4, 0, W * 0.38, H * 0.4, 860);
		g.addColorStop(0, '#fafafa');
		g.addColorStop(0.5, '#f2f2f4');
		g.addColorStop(1, '#e5e5e8');
		b.fillStyle = g;
		b.fillRect(0, 0, W, H);
		const v = b.createRadialGradient(W / 2, H / 2, 220, W / 2, H / 2, 740);
		v.addColorStop(0, 'rgba(0,0,0,0)');
		v.addColorStop(1, 'rgba(0,0,0,0.055)');
		b.fillStyle = v;
		b.fillRect(0, 0, W, H);
		// Static seeded monochrome grain, ~1.2%, baked once for every frame.
		const img = b.getImageData(0, 0, W * SS, H * SS);
		const d = img.data;
		const rnd = mulberry32(0x7d0f1a2e);
		const amp = 0.012 * 255;
		for (let i = 0; i < d.length; i += 4) {
			const n = (rnd() - 0.5) * 2 * amp;
			d[i] += n;
			d[i + 1] += n;
			d[i + 2] += n;
		}
		b.putImageData(img, 0, 0);
	}

	function bowPath(c, x, A) {
		c.beginPath();
		c.moveTo(x, -4);
		const steps = 110;
		for (let i = 0; i <= steps; i++) {
			const y = -4 + (i / steps) * (H + 8);
			c.lineTo(x + A * bumpShape(y), y);
		}
	}
	function drawRules(st) {
		const dim = st.t > 3.5 ? st.boardDim : 1;
		RULES.forEach((x, c) => {
			const e = st.rule[c];
			if (e <= 0.001) return;
			ctx.save();
			const yEnd = lerp(0, H + 4, e);
			const g = ctx.createLinearGradient(0, 0, 0, H);
			const alpha = 0.1 * dim * clamp(e * 1.4);
			g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(4)})`);
			g.addColorStop(clamp(yEnd / H), `rgba(0,0,0,${alpha.toFixed(4)})`);
			g.addColorStop(clamp((yEnd + 28) / H), 'rgba(0,0,0,0)');
			ctx.strokeStyle = g;
			ctx.lineWidth = 1;
			if (x === DIVIDER && Math.abs(st.A) > 0.01) bowPath(ctx, x + 0.5, st.A);
			else {
				ctx.beginPath();
				ctx.moveTo(x + 0.5, -4);
				ctx.lineTo(x + 0.5, yEnd);
			}
			ctx.stroke();
			ctx.restore();
		});
		// Energy shimmer along the Private divider while in contact & ringing.
		const t = st.t;
		const env = smooth(seg(t, G.tContact - 0.02, G.tContact + 0.02)) * (1 - smooth(seg(t, G.tApex + 0.08, G.tApex + 0.54)));
		if (env > 0.001) {
			const yi = G.impactY;
			const travel = Math.max(0, t - G.tApex) * 850;
			const g = ctx.createLinearGradient(0, yi - 280, 0, yi + 280);
			const N = 61;
			for (let k = 0; k < N; k++) {
				const o = k / (N - 1);
				const y = yi - 280 + o * 560;
				const core = Math.exp(-(((y - yi) / 130) ** 2));
				const glints = Math.exp(-(((y - (yi - travel)) / 24) ** 2)) + Math.exp(-(((y - (yi + travel)) / 24) ** 2));
				const a = env * clamp(0.95 * core + 0.8 * glints * (1 - seg(travel, 0, 280)));
				g.addColorStop(o, `rgba(37,99,235,${a.toFixed(4)})`);
			}
			ctx.save();
			ctx.strokeStyle = g;
			ctx.globalAlpha = 0.22;
			ctx.lineWidth = 9;
			bowPath(ctx, DIVIDER + 0.5, st.A);
			ctx.stroke();
			ctx.globalAlpha = 1;
			ctx.lineWidth = 2.4;
			ctx.stroke();
			ctx.restore();
		}
	}

	// Lucide-style 24-unit icons.
	function glyph(cx, cy, size, color, lw, draw) {
		ctx.save();
		ctx.translate(cx - size / 2, cy - size / 2);
		ctx.scale(size / 24, size / 24);
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = (lw * 24) / size;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		draw(ctx);
		ctx.restore();
	}
	const gripDots = (cx, cy, color) => {
		ctx.fillStyle = color;
		for (const dx of [-2.7, 2.7])
			for (const dy of [-5.2, 0, 5.2]) {
				ctx.beginPath();
				ctx.arc(cx + dx, cy + dy, 1.35, 0, Math.PI * 2);
				ctx.fill();
			}
	};
	const chevronLeft = (c) => {
		c.beginPath();
		c.moveTo(15, 18);
		c.lineTo(9, 12);
		c.lineTo(15, 6);
		c.stroke();
	};
	const share = (c) => {
		for (const [x, y] of [
			[18, 5],
			[6, 12],
			[18, 19],
		]) {
			c.beginPath();
			c.arc(x, y, 3, 0, Math.PI * 2);
			c.stroke();
		}
		c.beginPath();
		c.moveTo(8.59, 13.51);
		c.lineTo(15.42, 17.49);
		c.moveTo(15.41, 6.51);
		c.lineTo(8.59, 10.49);
		c.stroke();
	};
	const bot = (c) => {
		c.beginPath();
		c.roundRect(4, 8, 16, 12, 2);
		c.moveTo(12, 8);
		c.lineTo(12, 4);
		c.lineTo(8, 4);
		c.moveTo(2, 14);
		c.lineTo(4, 14);
		c.moveTo(20, 14);
		c.lineTo(22, 14);
		c.moveTo(9, 13);
		c.lineTo(9, 15);
		c.moveTo(15, 13);
		c.lineTo(15, 15);
		c.stroke();
	};
	const lock = (c) => {
		c.beginPath();
		c.roundRect(3, 11, 18, 11, 2.5);
		c.moveTo(7, 11);
		c.lineTo(7, 7);
		c.arc(12, 7, 5, Math.PI, 0);
		c.lineTo(17, 11);
		c.stroke();
	};

	function drawChrome(st) {
		const a = st.chrome * (st.t > 3.5 ? st.boardDim : 1);
		if (a <= 0.001) return;
		const mutedA = 0.42 * a;
		ctx.fillStyle = `rgba(0,0,0,${0.025 * a})`;
		ctx.fillRect(420, 0, 780, 46);
		ctx.fillStyle = `rgba(0,0,0,${0.09 * a})`;
		ctx.fillRect(420, 46, 780, 1);
		COLS.forEach((col) => gripDots(col.left + 14, 23, `rgba(0,0,0,${mutedA})`));
		const icon = `rgba(0,0,0,${0.42 * a})`;
		COLS.forEach((col, ci) => {
			const pop = eOutBack(clamp(a * 1.4 - ci * 0.15), 1.6);
			ctx.save();
			ctx.globalAlpha = clamp(a * 1.3 - ci * 0.1);
			glyph(col.left + 38, 23, 16, icon, 1.7, chevronLeft);
			const sc = lerp(0.6, 1, pop);
			if (ci === 0) glyph(col.right - 24, 23, 16 * sc, icon, 1.6, share);
			if (ci === 1) {
				glyph(col.right - 26, 23, 17 * sc, icon, 1.6, bot);
				ctx.beginPath();
				ctx.arc(col.right - 18, 15.5, 3.6 * sc, 0, Math.PI * 2);
				ctx.fillStyle = '#ffffff';
				ctx.fill();
				ctx.beginPath();
				ctx.arc(col.right - 18, 15.5, 2.6 * sc, 0, Math.PI * 2);
				ctx.fillStyle = C.sky;
				ctx.fill();
			}
			if (ci === 2) glyph(col.left + 62, 23, 15 * sc, icon, 1.7, lock);
			ctx.restore();
		});
	}

	function drawWordmark(st) {
		const p = st.p;
		const pc = clamp(p);
		const size = 112 * (38 / 112) ** p;
		const x = lerp(502, 454, p);
		const base = lerp(296, 148, p);
		const track = lerp(-0.025, -0.03, pc) * size;
		const dim = st.t > 3.5 ? lerp(1, st.boardDim, pc) : 1;
		ctx.save();
		ctx.globalAlpha = dim;
		ctx.font = F(700, size);
		ctx.letterSpacing = `${track}px`;
		ctx.fillStyle = C.ink;
		const xo = x + ctx.measureText('To').width - ctx.measureText('o').width - 0.008 * size;
		ctx.fillText('T', x, base);
		ctx.fillText('odoflare', xo, base);
		ctx.restore();
	}

	function drawHeadings(st) {
		drawWordmark(st);
		if (st.tagA > 0) {
			ctx.save();
			ctx.globalAlpha = st.tagA;
			ctx.font = F(400, 32);
			ctx.letterSpacing = '-0.15px';
			ctx.fillStyle = C.tagline;
			ctx.fillText('Local-first todo columns,', 504, 354 + st.tagDy);
			ctx.fillText('shared with people and AI agents.', 504, 398 + st.tagDy);
			ctx.restore();
		}
		const t = st.t;
		[1, 2].forEach((ci, k) => {
			const h = st.heads[k];
			if (h.a <= 0) return;
			const col = COLS[ci];
			ctx.save();
			ctx.globalAlpha = h.a;
			ctx.font = F(700, 38);
			ctx.letterSpacing = `${-0.03 * 38}px`;
			ctx.fillStyle = C.ink;
			ctx.fillText(col.title, col.x, 148 + h.dy);
			if (ci === 2) {
				// The lock pulses (1 → 1.30 → 1) with a 2-frame denial shake on impact.
				const u = seg(t, G.tApex - 0.02, G.tApex + 0.36);
				const pulse = u <= 0 || u >= 1 ? 0 : u < 0.25 ? eOut(u / 0.25) : 1 - eInOut((u - 0.25) / 0.75);
				const su = seg(t, G.tApex - 0.01, G.tApex + 0.14);
				const shake = su > 0 && su < 1 ? Math.sin(su * Math.PI * 4) * 4.5 * (1 - su) : 0;
				const lx = col.x + G.privateW + 14 + shake;
				const ly = 148 + h.dy - G.headCap / 2 - 1;
				if (pulse > 0) {
					const ru = seg(t, G.tApex - 0.02, G.tApex + 0.34);
					ctx.beginPath();
					ctx.arc(lx + 11, ly, 12 + 18 * eOut(ru), 0, Math.PI * 2);
					ctx.strokeStyle = `rgba(37,99,235,${0.48 * (1 - ru)})`;
					ctx.lineWidth = 1.8;
					ctx.stroke();
				}
				const sc = 1 + 0.3 * pulse;
				glyph(lx + 11, ly, 22 * sc, mix('#5a5a61', C.ink, pulse), 2.2, lock);
			}
			ctx.restore();
		});
	}

	function drawRowsText(st) {
		for (const r of G.rows) {
			const lay = st.rows[r.idx];
			if (lay.alpha <= 0.001) continue;
			ctx.save();
			ctx.globalAlpha = lay.alpha;
			ctx.translate(0, lay.y);
			ctx.scale(1, lay.sy);
			if (r.highlight) {
				const p = eOut(seg(st.t, r.highlight.t0, r.highlight.t1));
				if (p > 0) {
					const x0 = r.textX - 6;
					const x1 = x0 + p * (r.w + 12);
					ctx.beginPath();
					ctx.moveTo(x0 + 2, -13.5);
					ctx.lineTo(x1, -14.5);
					ctx.quadraticCurveTo(x1 + 3, 0, x1 - 1, 13.5);
					ctx.lineTo(x0, 14);
					ctx.quadraticCurveTo(x0 - 3, 0, x0 + 2, -13.5);
					ctx.fillStyle = HIGHLIGHT;
					ctx.fill();
				}
			}
			const m = r.muteT != null ? smooth(seg(st.t, r.muteT, r.muteT + 0.22)) : 0;
			ctx.font = F(500, 22);
			ctx.letterSpacing = '0px';
			ctx.fillStyle = m > 0 ? mix(C.text, C.done, m) : C.text;
			ctx.fillText(r.label, r.textX, r.base - r.y);
			ctx.restore();
		}
	}

	function drawCheckboxes(st) {
		for (const r of G.rows) {
			const lay = st.rows[r.idx];
			if (lay.alpha <= 0.001) continue;
			const dt = r.checkT != null ? st.t - r.checkT : -1;
			let sc = 1;
			let fill = 0;
			let draw = 0;
			if (dt >= 0) {
				fill = clamp(dt / 0.025);
				draw = eOut(seg(dt, 0.04, 0.16));
				if (dt < 0.06) sc = lerp(1, 0.82, eOut(dt / 0.06));
				else if (dt < 0.15) sc = lerp(0.82, 1.1, eInOut((dt - 0.06) / 0.09));
				else if (dt < 0.3) sc = lerp(1.1, 1, eInOut((dt - 0.15) / 0.15));
			}
			ctx.save();
			ctx.globalAlpha = lay.alpha;
			ctx.translate(r.boxX + BOX / 2, lay.y);
			ctx.scale(sc, sc * lay.sy);
			ctx.save();
			ctx.shadowColor = 'rgba(0,0,0,0.10)';
			ctx.shadowOffsetY = 1 * SS;
			ctx.shadowBlur = 2 * SS;
			ctx.beginPath();
			ctx.roundRect(-12, -12, 24, 24, 6);
			ctx.fillStyle = '#ffffff';
			ctx.fill();
			ctx.restore();
			ctx.beginPath();
			ctx.roundRect(-11, -11, 22, 22, 5);
			ctx.lineWidth = 2;
			ctx.strokeStyle = 'rgba(0,0,0,0.24)';
			ctx.stroke();
			if (fill > 0) {
				// The fill snaps in from the centre rather than fading through grey.
				const f = lerp(0.55, 1, eOut(fill));
				ctx.beginPath();
				ctx.roundRect(-12 * f, -12 * f, 24 * f, 24 * f, 6 * f);
				ctx.fillStyle = r.color;
				ctx.fill();
			}
			if (draw > 0) {
				ctx.beginPath();
				ctx.moveTo(-5.6, 0.4);
				ctx.lineTo(-1.6, 4.4);
				ctx.lineTo(5.8, -3.8);
				ctx.setLineDash([16.8 * draw, 40]);
				ctx.lineWidth = 2.7;
				ctx.lineCap = 'round';
				ctx.lineJoin = 'round';
				ctx.strokeStyle = '#ffffff';
				ctx.stroke();
				ctx.setLineDash([]);
			}
			ctx.restore();
		}
	}

	// ----------------------------------------------------------- threads --
	let porcelain = null;
	function visible(th, sT, sH, clampWall, A) {
		if (sH - sT < 0.3) return null;
		const p = th.path;
		const i0 = idxAt(p, sT);
		const i1 = idxAt(p, sH);
		const xs = [];
		const ys = [];
		const ss = [];
		const ws = [];
		const push = (x, y, sv, w) => {
			if (clampWall && x > WALL - 20) x = Math.min(x, stringX(y, A) - 2.4);
			xs.push(x);
			ys.push(y);
			ss.push(sv);
			ws.push(w);
		};
		const a = pointAt(p, sT);
		push(a.x, a.y, sT, th.width[i0]);
		for (let i = i0 + 1; i <= i1; i++) push(p.xs[i], p.ys[i], p.s[i], th.width[i]);
		const b = pointAt(p, sH);
		push(b.x, b.y, sH, th.width[Math.min(i1 + 1, p.n - 1)]);
		return { xs, ys, ss, ws };
	}
	function strokeRuns(c, v, from, to, colorAt, extra = 0) {
		c.lineCap = 'round';
		c.lineJoin = 'round';
		let start = from;
		const flush = (a, b) => {
			if (b <= a) return;
			c.beginPath();
			c.moveTo(v.xs[a], v.ys[a]);
			for (let i = a + 1; i <= b; i++) c.lineTo(v.xs[i], v.ys[i]);
			c.lineWidth = v.ws[a] + extra;
			c.strokeStyle = colorAt(a);
			c.stroke();
		};
		for (let i = from + 1; i <= to; i++) {
			if (Math.abs(v.ws[i] - v.ws[start]) > 0.04 || colorAt(i) !== colorAt(start)) {
				flush(start, i);
				start = i;
			}
		}
		flush(start, to);
	}
	function blueness(m, t, L) {
		if (t < T_UN) return 0;
		if (t < T_SNAP) return clamp((((t - T_UN) / 0.08) * (L + 12) - m) / 6);
		return 1 - clamp((((t - T_SNAP) / 0.18) * (L + 12) - m) / 6);
	}
	function renderThreads(st) {
		for (const X of [inX, outX]) {
			X.setTransform(1, 0, 0, 1, 0, 0);
			X.clearRect(0, 0, W * SS, H * SS);
			X.setTransform(SS, 0, 0, SS, 0, 0);
		}
		if (!porcelain) {
			porcelain = inX.createLinearGradient(0, IC.y + 60, 0, IC.y + 210);
			porcelain.addColorStop(0, '#ffffff');
			porcelain.addColorStop(1, '#f0f0f2');
		}
		const res = {};
		for (const th of [G.you, G.agent]) {
			const s = st[th.key];
			const isAgent = th.key === 'agent';
			const v = visible(th, s.sT, s.sH, isAgent, st.A);
			res[th.key] = v;
			if (!v) continue;
			const n = v.xs.length - 1;
			// Inside the icon (only the part before the squircle edge matters).
			let inTo = n;
			while (inTo > 0 && v.ss[inTo] > th.sExit + 12) inTo--;
			if (v.ss[0] < th.sExit + 12) {
				const inColor = isAgent
					? (i) => {
							const b = blueness(v.ss[i] - s.sT, st.tt, th.L);
							return b <= 0 ? porcelain : b >= 1 ? C.blueDark : mix(C.porcelain, C.blueDark, b);
						}
					: () => porcelain;
				strokeRuns(inX, v, 0, inTo, inColor);
			}
			// On paper.
			let outFrom = 0;
			while (outFrom < n && v.ss[outFrom] < th.sExit - 12) outFrom++;
			if (outFrom < n) strokeRuns(outX, v, outFrom, n, () => (isAgent ? C.blue : C.ink));
		}
		// Woven crossings: a bold 5.5px knockout on each side so the weave reads like fabric.
		for (const cr of G.crossings) {
			const vy = res.you;
			const va = res.agent;
			if (!vy || !va) continue;
			if (cr.sY < st.you.sT || cr.sY > st.you.sH || cr.sA < st.agent.sT || cr.sA > st.agent.sH) continue;
			const v = cr.upper === 'you' ? vy : va;
			const sC = cr.upper === 'you' ? cr.sY : cr.sA;
			let a = 0;
			while (a < v.ss.length - 1 && v.ss[a] < sC - 26) a++;
			let b = a;
			while (b < v.ss.length - 1 && v.ss[b] < sC + 26) b++;
			const color = cr.upper === 'you' ? C.ink : C.blue;
			outX.save();
			outX.beginPath();
			outX.arc(cr.x, cr.y, 18, 0, Math.PI * 2);
			outX.clip();
			outX.globalCompositeOperation = 'destination-out';
			strokeRuns(outX, v, a, b, () => '#000', 10.5);
			outX.globalCompositeOperation = 'source-over';
			strokeRuns(outX, v, a, b, () => color);
			outX.restore();
		}
		return res;
	}

	// --------------------------------------------------------------- icon --
	function iconTransform(c, st) {
		const sc = st.iconMorphScale * st.iconScale;
		c.translate(st.icx, st.icy - st.iconLift * 3);
		c.scale(sc, sc);
		c.translate(-ICX, -ICY);
	}
	function drawIcon(st) {
		const sc = st.iconMorphScale * st.iconScale;
		const lift = 1 + st.iconLift * 0.35;
		ctx.save();
		iconTransform(ctx, st);
		// Plane 1: machined anodized matte-black squircle with grounded shadow stack.
		const body = ctx.createLinearGradient(0, IC.y, 0, IC.y + BOARD_SIZE);
		body.addColorStop(0, '#323236');
		body.addColorStop(0.55, '#1b1b1e');
		body.addColorStop(1, '#111113');
		for (const [oy, blur, a] of [
			[44 * lift, 74 * lift, 0.2],
			[16 * lift, 32 * lift, 0.17],
			[2, 5, 0.28],
		]) {
			ctx.save();
			ctx.shadowColor = `rgba(0,0,0,${a})`;
			ctx.shadowOffsetY = oy * SS * sc;
			ctx.shadowBlur = blur * SS * sc;
			squirclePath(ctx);
			ctx.fillStyle = '#1b1b1e';
			ctx.fill();
			ctx.restore();
		}
		squirclePath(ctx);
		ctx.fillStyle = body;
		ctx.fill();
		ctx.save();
		squirclePath(ctx);
		ctx.clip();
		const sheen = ctx.createRadialGradient(ip(56, 22).x, ip(56, 22).y, 0, ip(56, 22).x, ip(56, 22).y, 240 * IC.s);
		sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
		sheen.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = sheen;
		ctx.fillRect(IC.x, IC.y, BOARD_SIZE, BOARD_SIZE);
		// Crisp top inner rim light fading by mid-height + subtle dark bottom bevel.
		const lit = ctx.createLinearGradient(0, IC.y, 0, IC.y + BOARD_SIZE * 0.52);
		lit.addColorStop(0, 'rgba(255,255,255,0.22)');
		lit.addColorStop(0.45, 'rgba(255,255,255,0.06)');
		lit.addColorStop(1, 'rgba(255,255,255,0)');
		squirclePath(ctx);
		ctx.lineWidth = 2.2;
		ctx.strokeStyle = lit;
		ctx.stroke();
		const rim = ctx.createLinearGradient(0, IC.y + BOARD_SIZE * 0.65, 0, IC.y + BOARD_SIZE);
		rim.addColorStop(0, 'rgba(0,0,0,0)');
		rim.addColorStop(1, 'rgba(0,0,0,0.62)');
		squirclePath(ctx);
		ctx.strokeStyle = rim;
		ctx.stroke();
		// Plane 3 (threads/check inside the icon) sits proud with a soft contact shadow.
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.shadowColor = 'rgba(0,0,0,0.58)';
		ctx.shadowOffsetY = 4.5 * SS * sc;
		ctx.shadowBlur = 9 * SS * sc;
		ctx.setTransform(SS * sc, 0, 0, SS * sc, SS * (st.icx - sc * ICX), SS * (st.icy - st.iconLift * 3 - sc * ICY));
		ctx.drawImage(inC, 0, 0, W, H);
		ctx.restore();
		ctx.restore();
		// Plane 2: extruded white ceramic ring with vertical gradient & subtle bottom shade.
		ctx.save();
		ctx.beginPath();
		ctx.roundRect(ip(56, 56).x, ip(56, 56).y, 144 * IC.s, 144 * IC.s, 32 * IC.s);
		ctx.roundRect(ip(72, 72).x, ip(72, 72).y, 112 * IC.s, 112 * IC.s, 16 * IC.s);
		const ring = ctx.createLinearGradient(0, ip(56, 56).y, 0, ip(200, 200).y);
		ring.addColorStop(0, '#ffffff');
		ring.addColorStop(0.7, '#f0f0f2');
		ring.addColorStop(1, '#d8d8de');
		ctx.fillStyle = ring;
		ctx.shadowColor = 'rgba(0,0,0,0.60)';
		ctx.shadowOffsetY = 2.5 * SS * sc;
		ctx.shadowBlur = 5 * SS * sc;
		ctx.fill('evenodd');
		ctx.restore();
		ctx.restore();
	}
	function drawOutThreads(st) {
		const sc = st.iconMorphScale * st.iconScale;
		ctx.save();
		ctx.beginPath();
		ctx.rect(-10, -10, W + 20, H + 20);
		const sz = BOARD_SIZE * sc;
		ctx.roundRect(st.icx - sz / 2, st.icy - st.iconLift * 3 - sz / 2, sz, sz, 56 * IC.s * sc);
		ctx.clip('evenodd');
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.shadowColor = 'rgba(0,0,0,0.16)';
		ctx.shadowOffsetY = 1.2 * SS;
		ctx.shadowBlur = 2.4 * SS;
		ctx.drawImage(outC, 0, 0);
		ctx.restore();
	}
	function drawIconFX(st) {
		const t = st.t;
		const d = t - T_SNAP;
		if (d < 0 || d > 0.68) return;
		const sc = st.iconMorphScale * st.iconScale;
		ctx.save();
		iconTransform(ctx, st);
		// Diagonal glass specular sweep across the squircle over ~10 frames.
		const ds = d - 0.01;
		if (ds > 0 && ds < 0.24) {
			const u = ds / 0.24;
			const p = lerp(-0.22, 1.22, eInOut(u));
			const amp = 0.28 * Math.sin(Math.PI * u);
			const f = (o) => amp * Math.max(0, 1 - Math.abs(o - p) / 0.12);
			const stops = [0, 1, p - 0.12, p, p + 0.12].filter((o) => o >= 0 && o <= 1).sort((a, b) => a - b);
			const g = ctx.createLinearGradient(IC.x, IC.y, IC.x + BOARD_SIZE, IC.y + BOARD_SIZE);
			for (const o of stops) g.addColorStop(o, `rgba(255,255,255,${f(o).toFixed(4)})`);
			ctx.save();
			squirclePath(ctx);
			ctx.clip();
			ctx.globalCompositeOperation = 'lighter';
			ctx.fillStyle = g;
			ctx.fillRect(IC.x, IC.y, BOARD_SIZE, BOARD_SIZE);
			ctx.restore();
		}
		// THE FLARE: white-hot core + subtle champagne glow + escaping 2.2x anamorphic streak!
		const I = eOut(clamp(d / 0.032)) * Math.exp(-d / 0.17) * (1 - smooth(seg(d, 0.44, 0.66)));
		if (I > 0.002) {
			const { x, y } = VTX;
			const grow = 0.72 + 0.55 * eOut(clamp(d / 0.16));
			// Soft warm-champagne bloom (no olive muddiness on black!).
			ctx.save();
			ctx.globalCompositeOperation = 'screen';
			const R = 115 * grow;
			const bloom = ctx.createRadialGradient(x, y, 0, x, y, R);
			bloom.addColorStop(0, `rgba(255,252,238,${0.95 * I})`);
			bloom.addColorStop(0.22, `rgba(255,232,165,${0.52 * I})`);
			bloom.addColorStop(0.55, `rgba(250,204,21,${0.18 * I})`);
			bloom.addColorStop(1, 'rgba(250,204,21,0)');
			ctx.fillStyle = bloom;
			ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
			// Escaping anamorphic streak (~2.2x icon width, reaches well out onto the paper!).
			const drawStreak = (hx, hy, thick, colorRgb, alphaScale) => {
				const g = hx > hy ? ctx.createLinearGradient(x - hx, y, x + hx, y) : ctx.createLinearGradient(x, y - hy, x, y + hy);
				g.addColorStop(0, `rgba(${colorRgb},0)`);
				g.addColorStop(0.32, `rgba(${colorRgb},${(0.45 * I * alphaScale).toFixed(4)})`);
				g.addColorStop(0.5, `rgba(${colorRgb},${(I * alphaScale).toFixed(4)})`);
				g.addColorStop(0.68, `rgba(${colorRgb},${(0.45 * I * alphaScale).toFixed(4)})`);
				g.addColorStop(1, `rgba(${colorRgb},0)`);
				ctx.fillStyle = g;
				ctx.beginPath();
				if (hx > hy) {
					ctx.moveTo(x - hx, y);
					ctx.lineTo(x, y - thick);
					ctx.lineTo(x + hx, y);
					ctx.lineTo(x, y + thick);
				} else {
					ctx.moveTo(x, y - hy);
					ctx.lineTo(x + thick, y);
					ctx.lineTo(x, y + hy);
					ctx.lineTo(x - thick, y);
				}
				ctx.closePath();
				ctx.fill();
			};
			// Outer soft amber-gold anamorphic wing (visible on light paper too via normal alpha!)
			ctx.globalCompositeOperation = 'source-over';
			drawStreak(310 * grow, 0, 6.2, '245,185,20', 0.52);
			drawStreak(0, 112 * grow, 4.2, '245,185,20', 0.4);
			// Razor-sharp white-hot core streak
			drawStreak(275 * grow, 0, 2.8, '255,255,255', 1.0);
			drawStreak(0, 98 * grow, 2.2, '255,255,255', 0.95);
			// Crisp 4-point star diamond
			const r = 42 * grow;
			const q = 3.2;
			ctx.beginPath();
			ctx.moveTo(x, y - r);
			ctx.quadraticCurveTo(x + q, y - q, x + r, y);
			ctx.quadraticCurveTo(x + q, y + q, x, y + r);
			ctx.quadraticCurveTo(x - q, y + q, x - r, y);
			ctx.quadraticCurveTo(x - q, y - q, x, y - r);
			ctx.fillStyle = `rgba(255,255,255,${I})`;
			ctx.fill();
			// White-hot core sphere
			const core = ctx.createRadialGradient(x, y, 0, x, y, 18 * grow);
			core.addColorStop(0, `rgba(255,255,255,${I})`);
			core.addColorStop(0.45, `rgba(255,252,240,${0.85 * I})`);
			core.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = core;
			ctx.fillRect(x - 18 * grow, y - 18 * grow, 36 * grow, 36 * grow);
			ctx.restore();
		}
		ctx.restore();
	}
	function drawDeflection(st) {
		const u = seg(st.t, G.tApex - 0.01, G.tApex + 0.24);
		if (u <= 0 || u >= 1) return;
		const x0 = WALL + 0.5;
		const y0 = G.impactY;
		ctx.save();
		ctx.strokeStyle = C.blue;
		ctx.lineCap = 'round';
		ctx.lineWidth = 2;
		ctx.globalAlpha = (1 - u) ** 1.4;
		for (const a of [148, 180, 212]) {
			const d = dirDeg(a);
			const r0 = 8 + 18 * eOut(u);
			const r1 = r0 + 8 * (1 - u) + 2;
			ctx.beginPath();
			ctx.moveTo(x0 + d.x * r0, y0 + d.y * r0);
			ctx.lineTo(x0 + d.x * r1, y0 + d.y * r1);
			ctx.stroke();
		}
		ctx.restore();
	}

	// ------------------------------------------------------------ cursors --
	// Show pill labels cleanly on entrance (~0.55s) and again for the Private
	// bounce + glide-through contrast (~2.32s–3.05s), with placement tuned to
	// avoid occluding row text or checkboxes.
	function drawCursor(x, y, kind, alpha, scale, pillAlpha, pillAbove) {
		if (alpha <= 0.001) return;
		const color = kind === 'you' ? C.ink : C.blue;
		const label = kind === 'you' ? 'You' : 'Agent';
		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.translate(x, y);
		ctx.scale(scale, scale);
		const mirror = kind === 'agent' ? -1 : 1;
		ctx.save();
		ctx.scale(mirror, 1);
		ctx.shadowColor = 'rgba(0,0,0,0.28)';
		ctx.shadowOffsetY = 1.5 * SS * scale;
		ctx.shadowBlur = 3.5 * SS * scale;
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(0, 19);
		ctx.lineTo(4.8, 14.7);
		ctx.lineTo(8, 21.6);
		ctx.lineTo(11.2, 20.2);
		ctx.lineTo(8.1, 13.4);
		ctx.lineTo(14.3, 13.2);
		ctx.closePath();
		ctx.fillStyle = color;
		ctx.fill();
		ctx.shadowColor = 'rgba(0,0,0,0)';
		ctx.lineJoin = 'round';
		ctx.lineWidth = 1.6;
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
		ctx.restore();
		if (pillAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = alpha * pillAlpha;
			ctx.font = F(600, 14.5);
			ctx.letterSpacing = '0px';
			const tw = ctx.measureText(label).width;
			const spark = kind === 'agent' ? 13 : 0;
			const ph = 25;
			const pw = tw + 20 + spark;
			const px = mirror > 0 ? 14 : -14 - pw;
			const py = pillAbove ? -32 : 22;
			ctx.save();
			ctx.shadowColor = 'rgba(0,0,0,0.20)';
			ctx.shadowOffsetY = 2 * SS * scale;
			ctx.shadowBlur = 6 * SS * scale;
			ctx.beginPath();
			ctx.roundRect(px, py, pw, ph, ph / 2);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.restore();
			ctx.save();
			ctx.beginPath();
			ctx.roundRect(px + 0.25, py + 0.25, pw - 0.5, ph - 0.5, ph / 2);
			const hl = ctx.createLinearGradient(0, py, 0, py + ph * 0.5);
			hl.addColorStop(0, 'rgba(255,255,255,0.32)');
			hl.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.lineWidth = 0.5;
			ctx.strokeStyle = hl;
			ctx.stroke();
			ctx.restore();
			if (spark) {
				const sx = px + 13;
				const sy = py + ph / 2;
				const r = 4.5;
				const q = 0.9;
				ctx.beginPath();
				ctx.moveTo(sx, sy - r);
				ctx.quadraticCurveTo(sx + q, sy - q, sx + r, sy);
				ctx.quadraticCurveTo(sx + q, sy + q, sx, sy + r);
				ctx.quadraticCurveTo(sx - q, sy + q, sx - r, sy);
				ctx.quadraticCurveTo(sx - q, sy - q, sx, sy - r);
				ctx.fillStyle = '#ffffff';
				ctx.fill();
			}
			ctx.fillStyle = '#ffffff';
			ctx.fillText(label, px + 10 + spark, py + 17.5);
			ctx.restore();
		}
		ctx.restore();
	}
	function drawCursors(st) {
		const t = st.t;
		for (const th of [G.you, G.agent]) {
			const pin = seg(t, th.tExit - 0.01, th.tExit + 0.14);
			const pout = seg(t, T_CURSOR_OUT, T_CURSOR_OUT + 0.12);
			const alpha = clamp(pin * 1.6) * (1 - pout);
			if (alpha <= 0) continue;
			const scale = lerp(0.55, 1, eOutBack(pin, 1.8)) * (1 - 0.35 * eIn(pout));
			let h = pointAt(th.path, th.head(t));
			if (th.key === 'agent' && h.x > WALL - 20) h = P(Math.min(h.x, stringX(h.y, st.A) - 2.4), h.y);
			// Intro pill (clear air between icon & Col 1, crisp pop-in, gone before touching any text)
			// + Private beat pill (clear air for blocked-vs-allowed contrast).
			const introPill = smooth(seg(t, th.tExit + 0.06, th.tExit + 0.12)) * (1 - smooth(seg(t, 1.31, 1.39)));
			const climaxPill =
				th.key === 'agent'
					? smooth(seg(t, 2.34, 2.42)) * (1 - smooth(seg(t, 2.96, 3.08)))
					: smooth(seg(t, 2.66, 2.74)) * (1 - smooth(seg(t, 3.04, 3.14)));
			const pillAlpha = clamp(Math.max(introPill, climaxPill));
			// Keep pills strictly clear of row text & headings:
			// You always above in clear upper air (clear of both Private heading and Taxes);
			// Agent always below in open lower air.
			const pillAbove = th.key === 'you';
			drawCursor(h.x, h.y + 6 * eIn(pout), th.key, alpha, scale, pillAlpha, pillAbove);
		}
	}

	// -------------------------------------------------------------- frame --
	function drawScene(t, tt) {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
		ctx.shadowColor = 'rgba(0,0,0,0)';
		ctx.drawImage(bgC, 0, 0);
		ctx.setTransform(SS, 0, 0, SS, 0, 0);
		const st = state(t, tt);
		renderThreads(st);
		drawRules(st);
		drawChrome(st);
		drawHeadings(st);
		drawRowsText(st);
		drawIcon(st);
		drawOutThreads(st);
		drawCheckboxes(st);
		drawIconFX(st);
		drawCursors(st);
	}

	// 180° shutter with 4 sub-frames during the fast reel-back. Only the
	// threads move between sub-frames; the board stays razor sharp.
	const BLUR_FROM = 195;
	const BLUR_TO = 230;
	let acc = null;
	function renderFrame(i) {
		const t = i / FPS;
		if (i >= BLUR_FROM && i <= BLUR_TO) {
			if (!acc) acc = new Uint16Array(W * SS * H * SS * 4);
			acc.fill(0);
			for (let k = 0; k < 4; k++) {
				drawScene(t, t - (k / 3) * (0.5 / FPS));
				const d = ctx.getImageData(0, 0, W * SS, H * SS).data;
				for (let j = 0; j < d.length; j++) acc[j] += d[j];
			}
			const out = new Uint8ClampedArray(acc.length);
			for (let j = 0; j < acc.length; j++) out[j] = (acc[j] + 2) >> 2;
			return out;
		}
		drawScene(t, t);
		return ctx.getImageData(0, 0, W * SS, H * SS).data;
	}

	window.__og = {
		async init() {
			const faces = [
				['Regular', 400],
				['Medium', 500],
				['Semibold', 600],
				['Bold', 700],
				['Heavy', 800],
				['Black', 900],
			];
			const loaded = [];
			for (const [name, weight] of faces) {
				try {
					const face = new FontFace('SF Pro Display', `url(/fonts/SF-Pro-Display-${name}.otf)`, { weight: String(weight) });
					await face.load();
					document.fonts.add(face);
					loaded.push(weight);
				} catch {
					// Fall back to the installed system face.
				}
			}
			await document.fonts.ready;
			const check = [400, 500, 600, 700, 800].map((w) => [w, document.fonts.check(F(w, 40))]);
			bakeBackground();
			const info = build();
			return { loaded, check, ...info };
		},
		drawFrame(i) {
			ctx.putImageData(new ImageData(renderFrame(i), W * SS, H * SS), 0, 0);
		},
		drawStill() {
			drawScene(0, 0);
		},
		bench(frames) {
			// Development aid: per-stage timings. Not used for output.
			const out = {};
			for (const i of frames) {
				const t = i / FPS;
				const a = performance.now();
				drawScene(t, t);
				const b = performance.now();
				const d = ctx.getImageData(0, 0, W * SS, H * SS);
				const c = performance.now();
				out[i] = { draw: Math.round(b - a), read: Math.round(c - b), bytes: d.data.length };
			}
			return out;
		},
		async post(i, tag) {
			const data = renderFrame(i);
			// A Blob body is ~40× faster to upload than a typed array in Chromium.
			const res = await fetch(`/frame?tag=${encodeURIComponent(tag)}&i=${i}`, { method: 'POST', body: new Blob([data]) });
			if (!res.ok) throw new Error(`post failed ${res.status}`);
		},
		async postSheet(frames) {
			// frames: [{src, label}] → 4×4 labelled contact sheet.
			const cw = 600;
			const chh = 315;
			const pad = 14;
			const lab = 34;
			const sheet = document.createElement('canvas');
			sheet.width = 4 * cw + 5 * pad;
			sheet.height = 4 * (chh + lab) + 5 * pad;
			const s = sheet.getContext('2d');
			s.fillStyle = '#1b1b1e';
			s.fillRect(0, 0, sheet.width, sheet.height);
			for (let k = 0; k < frames.length; k++) {
				const img = new Image();
				img.src = frames[k].src;
				await img.decode();
				const cx = pad + (k % 4) * (cw + pad);
				const cy = pad + Math.floor(k / 4) * (chh + lab + pad);
				s.drawImage(img, cx, cy + lab, cw, chh);
				s.font = F(600, 18);
				s.fillStyle = '#f4f4f5';
				s.fillText(frames[k].label, cx + 2, cy + 23);
			}
			const blob = await new Promise((r) => sheet.toBlob(r, 'image/png'));
			const res = await fetch('/frame?tag=sheet', { method: 'POST', body: blob });
			if (!res.ok) throw new Error('sheet post failed');
		},
	};
	window.drawFrame = (i) => window.__og.drawFrame(i);
	window.drawStill = () => window.__og.drawStill();
}

// ---------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>og</title>
<style>html,body{margin:0;background:#000}canvas{display:block;width:1200px;height:630px}</style>
</head><body><canvas id="stage"></canvas>
<script>(${renderer.toString()})();</script>
</body></html>`;

function run(cmd, argv, { input, capture } = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, argv, { stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
		let out = '';
		let err = '';
		if (capture) p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`))));
		if (input) p.stdin.end(input);
	});
}

function rawToPng(buf, file, size = '1200:630') {
	return run(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-', '-vf', `scale=${size}:flags=lanczos,format=rgb24`, '-frames:v', '1', file], { input: buf });
}

function write(stream, buf) {
	return new Promise((resolve, reject) => {
		const onError = (e) => reject(e);
		stream.once('error', onError);
		const done = () => {
			stream.off('error', onError);
			resolve();
		};
		if (stream.write(buf)) done();
		else stream.once('drain', done);
	});
}

async function main() {
	const fontFile = (name) => FONT_DIRS.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
	let sink = async () => {};
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://localhost');
			if (req.method === 'GET' && url.pathname === '/') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(PAGE);
				return;
			}
			if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
				const name = path.basename(url.pathname);
				const file = /^SF-Pro-Display-[A-Za-z]+\.otf$/.test(name) ? fontFile(name) : null;
				if (!file) {
					res.writeHead(404);
					res.end();
					return;
				}
				res.writeHead(200, { 'content-type': 'font/otf' });
				fs.createReadStream(file).pipe(res);
				return;
			}
			if (req.method === 'GET' && url.pathname.startsWith('/qa/')) {
				const file = path.join(qaFrameDir, path.basename(url.pathname));
				res.writeHead(200, { 'content-type': 'image/png' });
				fs.createReadStream(file).pipe(res);
				return;
			}
			if (req.method === 'POST' && url.pathname === '/frame') {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				await sink(Buffer.concat(chunks), url.searchParams.get('tag'), Number(url.searchParams.get('i')));
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		} catch (e) {
			console.error(e);
			res.writeHead(500);
			res.end(String(e));
		}
	});
	let qaFrameDir = os.tmpdir();
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const origin = `http://127.0.0.1:${server.address().port}`;

	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
		page.on('pageerror', (e) => console.error('[page]', e));
		page.on('console', (m) => {
			if (m.type() === 'error') console.error('[page]', m.text());
		});
		await page.goto(origin);
		const info = await page.evaluate(() => window.__og.init());
		console.log('fonts loaded (weights):', info.loaded.join(', ') || 'none — using system fallback');
		console.log('fonts check:', info.check.map(([w, ok]) => `${w}:${ok ? 'ok' : 'MISSING'}`).join(' '));
		console.log('native T/o kern @114px:', info.kernTo.toFixed(2), 'px');
		console.log('path lengths (you, agent):', info.lengths.join(', '));
		console.log('cursor exits (you, agent):', info.exits.join(', '));
		console.log('crossings [x, y, upper]:', JSON.stringify(info.crossings));
		console.log('checks [row, check t, collapse t]:', JSON.stringify(info.checks));

		if (args.bench) {
			console.log(await page.evaluate(() => window.__og.bench([0, 0, 100, 150, 216, 236, 285])));
			const a = Date.now();
			sink = async () => {};
			for (const i of [100, 101, 102, 103, 104]) await page.evaluate(([i]) => window.__og.post(i, 'bench'), [i]);
			console.log('post round-trip per frame:', (Date.now() - a) / 5, 'ms');
			return;
		}
		const qa = args.qa;
		if (qa) fs.mkdirSync(qa, { recursive: true });

		if (args.preview) {
			const dir = qa ?? fs.mkdtempSync(path.join(os.tmpdir(), 'og-preview-'));
			sink = async (buf, tag, i) => rawToPng(buf, path.join(dir, `preview-${String(i).padStart(3, '0')}.png`));
			for (const i of args.preview) await page.evaluate(([i]) => window.__og.post(i, 'preview'), [i]);
			console.log('preview frames written to', dir);
			return;
		}

		// Still: frame 0 is the og:image.
		const t0 = Date.now();
		sink = async (buf) => rawToPng(buf, OUT_PNG);
		await page.evaluate(() => window.__og.post(0, 'still'));
		console.log('wrote', path.relative(ROOT, OUT_PNG), `(${fs.statSync(OUT_PNG).size} bytes)`);

		// Video: raw 2400×1260 RGBA frames straight into ffmpeg.
		let crf = args.crf ?? 19;
		for (;;) {
			const ff = spawn(
				FFMPEG,
				[
					'-y',
					'-v',
					'error',
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgba',
					'-s',
					`${W}x${H}`,
					'-r',
					'60',
					'-i',
					'-',
					'-vf',
					'scale=1200:630:flags=lanczos:out_color_matrix=bt709,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
					'-c:v',
					'libx264',
					'-preset',
					'slow',
					'-tune',
					'animation',
					'-crf',
					String(crf),
					'-profile:v',
					'high',
					'-level',
					'4.2',
					'-x264-params',
					'keyint=300:min-keyint=300:scenecut=0',
					'-colorspace',
					'bt709',
					'-color_primaries',
					'bt709',
					'-color_trc',
					'bt709',
					'-movflags',
					'+faststart',
					'-an',
					OUT_MP4,
				],
				{ stdio: ['pipe', 'ignore', 'pipe'] },
			);
			let ffErr = '';
			ff.stderr.on('data', (d) => (ffErr += d));
			const closed = new Promise((resolve, reject) => ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}\n${ffErr}`)))));
			sink = async (buf) => write(ff.stdin, buf);
			for (let i = 0; i < FRAMES; i++) {
				await page.evaluate(([i]) => window.__og.post(i, 'video'), [i]);
				if (i % 30 === 29) process.stdout.write(`  frames ${i + 1}/${FRAMES}\r`);
			}
			ff.stdin.end();
			await closed;
			const size = fs.statSync(OUT_MP4).size;
			console.log(`wrote ${path.relative(ROOT, OUT_MP4)} (${size} bytes, crf ${crf}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
			if (size <= MAX_MP4_BYTES || crf >= 23 || args.crf != null) break;
			crf += 1;
			console.log(`  over ${MAX_MP4_BYTES} bytes, retrying at crf ${crf}`);
		}

		const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames,color_space,color_primaries,color_transfer:format=duration,size', '-of', 'default=noprint_wrappers=1', OUT_MP4], { capture: true });
		console.log(probe.out.trim());

		if (!qa) return;
		// QA: frame 0 vs frame 300 (one loop later) must match.
		const f0 = path.join(qa, 'og-frame-000.png');
		const f300 = path.join(qa, 'og-frame-300.png');
		fs.copyFileSync(OUT_PNG, f0);
		sink = async (buf) => rawToPng(buf, f300);
		await page.evaluate(() => window.__og.post(300, 'f300'));
		const ssim = await run(FFMPEG, ['-v', 'info', '-i', f0, '-i', f300, '-lavfi', 'ssim', '-f', 'null', '-']);
		console.log('SSIM frame 0 vs 300:', (ssim.err.match(/All:([0-9.]+)/) ?? [])[1]);
		const seam = await run(FFMPEG, ['-v', 'info', '-i', OUT_MP4, '-i', OUT_MP4, '-lavfi', '[0:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=299:end_frame=300,setpts=PTS-STARTPTS[b];[a][b]ssim', '-f', 'null', '-']);
		console.log('SSIM mp4 frame 0 vs 299:', (seam.err.match(/All:([0-9.]+)/) ?? [])[1]);
		await run(FFMPEG, ['-y', '-v', 'error', '-i', OUT_PNG, '-vf', 'scale=300:-1:flags=lanczos', path.join(qa, 'og-thumb-300.png')]);
		await run(FFMPEG, ['-y', '-v', 'error', '-i', OUT_PNG, '-vf', 'scale=150:-1:flags=lanczos', path.join(qa, 'og-thumb-150.png')]);

		const beats = [
			[0, 'Hero card (og:image)'],
			[36, 'Card morphs + icon glides'],
			[60, 'Board ready'],
			[72, 'Check splits cleanly'],
			[84, 'You & Agent exit'],
			[102, 'Rhyming hairpins'],
			[126, 'Gutter weave'],
			[140, 'Sourdough ✓ (Agent)'],
			[151, 'Private bows 32px!'],
			[158, 'Agent recoils back'],
			[168, 'Hold: blocked vs allowed'],
			[176, 'You glide straight through'],
			[190, 'Call mom ✓'],
			[214, 'Reel-back (motion blur)'],
			[232, 'Escaping Flare!'],
			[285, 'Loop seam = frame 0'],
		];
		qaFrameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-sheet-'));
		await run(FFMPEG, ['-y', '-v', 'error', '-i', OUT_MP4, '-vf', `select='${beats.map(([n]) => `eq(n\\,${n})`).join('+')}'`, '-fps_mode', 'passthrough', path.join(qaFrameDir, 'f%02d.png')]);
		const frames = beats.map(([n, label], k) => ({ src: `/qa/f${String(k + 1).padStart(2, '0')}.png`, label: `f${n} · ${(n / 60).toFixed(2)}s · ${label}` }));
		sink = async (buf) => fs.writeFileSync(path.join(qa, 'og-contact-sheet.png'), buf);
		await page.evaluate((frames) => window.__og.postSheet(frames), frames);
		fs.rmSync(qaFrameDir, { recursive: true, force: true });
		console.log('QA written to', qa);
	} finally {
		await browser.close();
		server.close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
