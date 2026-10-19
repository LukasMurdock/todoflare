// Fails when the client JavaScript grows past its budget.
//
// Usage: node scripts/check-bundle-size.mjs [ASSETS_DIR]   (default dist/client/assets)
//
// Baseline before the embeddable board: 421.9 KiB gzip. After excluding the
// unused Yjs providers: 385.4 KiB. React 19.3, zod 4.6 and Plate 53.3 (slate)
// added 22 KiB upstream: 407.4 KiB. The budget leaves a little room; raise it
// deliberately, with the reason in the commit.
//
// Agent access added 8.9 KiB: 3.6 KiB in the board (each column's agent
// popover) and 5.3 KiB in two chunks loaded only on demand (the Agents dialog
// and the OAuth consent page). Measured total 418.4 KiB; budget 415 → 420.
//
// The guided Agents setup (numbered steps per app, a shared column picker)
// added 2.6 KiB, all in on-demand chunks; the board grew 0.3 KiB. Measured
// total 421.0 KiB; budget 420 → 423.
//
// Agent change diffs in each column's agent popover (added, removed and
// changed items) and "All columns" in the column picker added 1.8 KiB, 1.55 KiB
// of it in the board. Loading the diff view on demand made things worse: it
// split the shared class-name helpers into their own chunk, saving 0.3 KiB on
// first load and adding 1.1 KiB in total. Measured total 423.5 KiB; budget
// 423 → 426.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_GZIP_KIB = 426;
const dir = process.argv[2] ?? "dist/client/assets";
const files = readdirSync(dir).filter((file) => file.endsWith(".js"));
if (files.length === 0) throw new Error(`No JavaScript in ${dir}; build first.`);
const total = files.reduce((sum, file) => sum + gzipSync(readFileSync(path.join(dir, file))).length, 0) / 1024;
if (total > BUDGET_GZIP_KIB) {
	console.error(`Client JS is ${total.toFixed(1)} KiB gzip, over the ${BUDGET_GZIP_KIB} KiB budget.`);
	process.exit(1);
}
console.log(`Client JS: ${total.toFixed(1)} KiB gzip (budget ${BUDGET_GZIP_KIB} KiB).`);
