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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_GZIP_KIB = 420;
const dir = process.argv[2] ?? "dist/client/assets";
const files = readdirSync(dir).filter((file) => file.endsWith(".js"));
if (files.length === 0) throw new Error(`No JavaScript in ${dir}; build first.`);
const total = files.reduce((sum, file) => sum + gzipSync(readFileSync(path.join(dir, file))).length, 0) / 1024;
if (total > BUDGET_GZIP_KIB) {
	console.error(`Client JS is ${total.toFixed(1)} KiB gzip, over the ${BUDGET_GZIP_KIB} KiB budget.`);
	process.exit(1);
}
console.log(`Client JS: ${total.toFixed(1)} KiB gzip (budget ${BUDGET_GZIP_KIB} KiB).`);
