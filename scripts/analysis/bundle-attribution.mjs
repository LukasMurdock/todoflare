// Bundle attribution: which code ships to the browser, by zone and package?
//
// Usage: node scripts/analysis/bundle-attribution.mjs [--json] [--top N] ASSETS_DIR
//
// ASSETS_DIR is a client build made with `vite build --sourcemap`. Each byte of
// minified JavaScript is attributed to the original source its sourcemap
// segment points at: board or host (see ./board-zones.mjs) for our code, the
// package name for dependencies. Gzip and Brotli sizes are reported per file
// because compressed bytes cannot be attributed to individual sources.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { zoneOf } from "./board-zones.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const top = args.includes("--top") ? Number(args[args.indexOf("--top") + 1]) : 25;
const assetsDir = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--top").at(-1);
if (!assetsDir) throw new Error("Usage: bundle-attribution.mjs [--json] [--top N] ASSETS_DIR");

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes sourcemap v3 "mappings" into [generatedLine, generatedColumn, sourceIndex] segments. */
function decodeMappings(mappings) {
	const segments = [];
	let sourceIndex = 0;
	mappings.split(";").forEach((line, lineIndex) => {
		let column = 0;
		for (const segment of line.split(",")) {
			if (!segment) continue;
			const values = [];
			let value = 0;
			let shift = 0;
			for (const char of segment) {
				const digit = BASE64.indexOf(char);
				value += (digit & 31) << shift;
				if (digit & 32) {
					shift += 5;
				} else {
					values.push(value & 1 ? -(value >>> 1) : value >>> 1);
					value = 0;
					shift = 0;
				}
			}
			column += values[0];
			if (values.length > 1) sourceIndex += values[1];
			segments.push([lineIndex, column, values.length > 1 ? sourceIndex : -1]);
		}
	});
	return segments;
}

function owner(source) {
	const normalized = source.replace(/\\/g, "/");
	const pnpm = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(normalized);
	const plain = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(normalized);
	const pkg = pnpm?.[1] ?? plain?.[1];
	if (pkg) return { group: "dependency", name: pkg };
	const src = /(?:^|\/)((?:packages\/[^/]+\/)?src\/.+)$/.exec(normalized);
	if (src) return { group: zoneOf(src[1]), name: src[1] };
	return { group: "other", name: normalized };
}

const files = [];
const byGroup = new Map();
const byName = new Map();

for (const file of readdirSync(assetsDir)) {
	const absolute = path.join(assetsDir, file);
	if (file.endsWith(".css")) {
		const css = readFileSync(absolute);
		files.push({ file, bytes: css.length, gzip: gzipSync(css).length, brotli: brotliCompressSync(css).length });
		continue;
	}
	if (!file.endsWith(".js")) continue;
	const code = readFileSync(absolute, "utf8");
	files.push({ file, bytes: Buffer.byteLength(code), gzip: gzipSync(code).length, brotli: brotliCompressSync(code).length });

	const map = JSON.parse(readFileSync(`${absolute}.map`, "utf8"));
	const lines = code.split("\n");
	const segments = decodeMappings(map.mappings);
	for (let i = 0; i < segments.length; i++) {
		const [line, column, sourceIndex] = segments[i];
		const next = segments[i + 1];
		const end = next && next[0] === line ? next[1] : (lines[line] ?? "").length;
		const size = Math.max(0, end - column);
		const source = sourceIndex >= 0 ? map.sources[sourceIndex] : null;
		const { group, name } = source ? owner(source) : { group: "unmapped", name: "(unmapped)" };
		byGroup.set(group, (byGroup.get(group) ?? 0) + size);
		const key = `${group}\t${name}`;
		byName.set(key, (byName.get(key) ?? 0) + size);
	}
}

const total = [...byGroup.values()].reduce((a, b) => a + b, 0);
const packages = new Map();
for (const [key, size] of byName) {
	const [group, name] = key.split("\t");
	if (group !== "dependency") continue;
	packages.set(name, size);
}
const ourFiles = [...byName].filter(([key]) => /^(board|host)\t/.test(key));

const report = {
	files,
	attributedJsBytes: total,
	groups: Object.fromEntries([...byGroup].sort((a, b) => b[1] - a[1])),
	topPackages: [...packages].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, bytes]) => ({ name, bytes })),
	topSourceFiles: ourFiles.sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, bytes]) => {
		const [zone, file] = key.split("\t");
		return { zone, file, bytes };
	}),
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
	console.log("## Files");
	for (const f of files) console.log(`  ${f.file}: ${kb(f.bytes)} min, ${kb(f.gzip)} gzip, ${kb(f.brotli)} brotli`);
	console.log(`\n## Minified JS by origin (${kb(total)} attributed)`);
	for (const [group, bytes] of Object.entries(report.groups)) console.log(`  ${group.padEnd(11)} ${kb(bytes).padStart(11)}  ${((100 * bytes) / total).toFixed(1)}%`);
	console.log(`\n## Top ${top} dependencies`);
	for (const p of report.topPackages) console.log(`  ${p.name.padEnd(40)} ${kb(p.bytes).padStart(11)}`);
	console.log(`\n## Top ${top} source files`);
	for (const s of report.topSourceFiles) console.log(`  ${s.zone.padEnd(6)} ${s.file.padEnd(52)} ${kb(s.bytes).padStart(10)}`);
}
