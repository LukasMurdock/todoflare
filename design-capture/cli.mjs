#!/usr/bin/env node
/**
 * Automated UI screen capture & Design Hill-Climb feed generator for Todoflare.
 *
 * Captures any built-in surface, state, account configuration, or multi-step
 * flow (or any custom JSON `--spec`), across any viewport × theme matrix, and
 * generates:
 *   - .design-review/<run>/shots/*.png (+ optional .mp4 flow videos)
 *   - .design-review/<run>/contact-sheets/<category>.png (agent-readable sheets)
 *   - .design-review/<run>/diffs/*.diff.png (when --compare <other-run> is set)
 *   - .design-review/<run>/manifest.json (full structured metadata + diagnostics)
 *   - .design-review/<run>/index.html (interactive UI Review Feed + slider diff)
 *   - .design-review/index.html (history of all hill-climb runs)
 *
 * Examples:
 *   pnpm capture:ui
 *   pnpm capture:ui --run baseline --themes light,dark --viewports desktop,mobile
 *   pnpm capture:ui --run iter-01 --compare baseline --filter "share-*,agents-*"
 *   pnpm capture:ui --spec design-capture/example-spec.json --video
 *   pnpm capture:ui --list
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium, request as pwRequest } from "@playwright/test";
import { buildContactSheets, computeHillClimbDiffs, convertWebmToMp4, writeReviewFeedHtml, writeRunsIndexHtml } from "./feed-builder.mjs";
import { attachDiagnostics, collectLayoutDiagnostics, createCaptureContext, parseViewport } from "./helpers.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { loadSpecScenarios } from "./spec-runner.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUT_ROOT = path.join(ROOT, ".design-review");

const p = (n) => String(n).padStart(2, "0");

function parseArgs(argv) {
	const out = {
		run: null,
		compare: null,
		filter: null,
		category: null,
		themes: ["light"],
		viewports: ["desktop"],
		dpr: 1,
		video: false,
		spec: null,
		list: false,
		noBuild: false,
		url: null,
		outRoot: DEFAULT_OUT_ROOT,
		contactSheets: true,
		fullPage: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--run") {out.run = argv[++i];}
		else if (a === "--compare") {out.compare = argv[++i];}
		else if (a === "--filter") {out.filter = argv[++i];}
		else if (a === "--category") {out.category = argv[++i];}
		else if (a === "--themes" || a === "--theme") {out.themes = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);}
		else if (a === "--viewports" || a === "--viewport") {out.viewports = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);}
		else if (a === "--dpr") {out.dpr = Number(argv[++i]);}
		else if (a === "--video") {out.video = true;}
		else if (a === "--spec") {out.spec = path.resolve(argv[++i]);}
		else if (a === "--list") {out.list = true;}
		else if (a === "--no-build") {out.noBuild = true;}
		else if (a === "--url") {out.url = argv[++i];}
		else if (a === "--out") {out.outRoot = path.resolve(argv[++i]);}
		else if (a === "--no-contact-sheets") {out.contactSheets = false;}
		else if (a === "--full-page") {out.fullPage = true;}
		else if (a === "-h" || a === "--help") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown option: ${a} (use --help)`);
		}
	}
	for (const t of out.themes) {
		if (t !== "light" && t !== "dark") {throw new Error(`Invalid theme "${t}". Use light or dark.`);}
	}
	return out;
}

function printHelp() {
	console.log(`Usage: pnpm capture:ui [options]

Options:
  --run <name>           Run directory name under .design-review/ (default: timestamp)
  --compare <run>        Compare against an earlier run and generate pixel diffs + slider UI
  --filter <patterns>    Comma-separated IDs or globs (e.g. "share-*,agents-dialog-*")
  --category <cats>      Comma-separated categories: guest,account,sharing,agents,flows
  --themes <list>        light | dark | light,dark (default: light)
  --viewports <list>     desktop,laptop,tablet,mobile or WxH (default: desktop)
  --dpr <1|2>            Device pixel ratio (default: 1)
  --video                Record MP4 videos of captured flows/scenarios
  --full-page            Capture full scrollable page height
  --spec <file.json>     Capture custom declarative flow/state spec instead of built-ins
  --no-build             Skip pnpm build:e2e (reuse existing dist/)
  --url <origin>         Reuse an already-running E2E server instead of starting one
  --no-contact-sheets    Skip generating category contact sheet PNGs
  --out <dir>            Output root directory (default: .design-review)
  --list                 List all built-in scenarios and exit`);
}

function matchesGlob(value, pattern) {
	const re = new RegExp(`^${pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', ".*")}$`, "i");
	return re.test(value);
}

function selectScenarios(all, args) {
	let list = all;
	if (args.category) {
		const cats = new Set(args.category.split(",").map((s) => s.trim().toLowerCase()));
		list = list.filter((s) => cats.has(s.category.toLowerCase()));
	}
	if (args.filter) {
		const pats = args.filter.split(",").map((s) => s.trim()).filter(Boolean);
		list = list.filter((s) => pats.some((p) => matchesGlob(s.id, p) || matchesGlob(s.surface, p)));
	}
	return list;
}

function defaultRunName() {
	const d = new Date();

	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitShortSha() {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return "";
	}
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function runSyncPnpm(args, env = {}) {
	execFileSync("pnpm", args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
}

async function waitForServer(url, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/api/clock`);
			if (res.ok) {return;}
		} catch {
			// Server still booting.
		}
		await new Promise((r) => { setTimeout(r, 250); });
	}
	throw new Error(`Timed out waiting for E2E preview server at ${url}`);
}

async function startIsolatedServer() {
	// Uses the exact same isolated .wrangler/e2e-state lifecycle as `pnpm e2e:serve`,
	// on an ephemeral port so it never collides with a running dev/e2e server.
	runSyncPnpm(["e2e:reset-state"]);
	execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "AUTH_DB", "--local", "--persist-to", ".wrangler/e2e-state"], {
		cwd: ROOT,
		stdio: "pipe",
	});
	const port = await getFreePort();
	const url = `http://127.0.0.1:${port}`;
	const child = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: ROOT,
		env: { ...process.env, TODOFLARE_E2E: "true" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	child.on("exit", (code) => {
		if (code && code !== 0) {
			console.error(`[preview exited ${code}]\n${stderr.slice(-1500)}`);
		}
	});
	await waitForServer(url);
	return {
		url,
		async stop() {
			if (typeof child.pid !== "number") {return;}
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				try { child.kill("SIGTERM"); } catch { /* already exited */ }
			}
			await new Promise((r) => { setTimeout(r, 250); });
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already stopped.
			}
		},
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const allScenarios = args.spec ? loadSpecScenarios(args.spec) : SCENARIOS;

	if (args.list) {
		console.log(`Built-in Todoflare UI capture scenarios (${allScenarios.length}):\n`);
		for (const s of allScenarios) {
			console.log(`  ${s.id.padEnd(34)} [${s.category.padEnd(7)}]  ${s.title}`);
		}
		return;
	}

	const selected = selectScenarios(allScenarios, args);
	if (selected.length === 0) {
		throw new Error("No scenarios matched the given --category / --filter options.");
	}

	const viewports = args.viewports.map(parseViewport);
	const runName = args.run ?? defaultRunName();
	const runDir = path.join(args.outRoot, runName);
	const shotsDir = path.join(runDir, "shots");
	const videosDir = path.join(runDir, "videos");
	fs.mkdirSync(shotsDir, { recursive: true });
	if (args.video) {fs.mkdirSync(videosDir, { recursive: true });}

	if (!args.url && !args.noBuild) {
		console.log("Building isolated E2E bundle (pass --no-build to reuse existing dist/)...");
		runSyncPnpm(["build:e2e"]);
	}

	let server = null;
	const baseURL = args.url ?? (server = await startIsolatedServer()).url;
	console.log(`Capturing ${selected.length} scenario(s) × ${args.themes.length} theme(s) × ${viewports.length} viewport(s) against ${baseURL} → .design-review/${runName}/`);

	const browser = await chromium.launch();
	const apiRequest = await pwRequest.newContext({ baseURL });
	const shots = [];
	const failures = [];
	const t0 = Date.now();

	try {
		for (const theme of args.themes) {
			for (const viewport of viewports) {
				for (const scenario of selected) {
					const matrixTag = `${theme}_${viewport.name}`;
					const rawVideoDir = args.video ? path.join(videosDir, "_raw") : null;
					if (rawVideoDir) {fs.mkdirSync(rawVideoDir, { recursive: true });}

					const context = await createCaptureContext(browser, {
						baseURL,
						viewport,
						theme,
						dpr: args.dpr,
						recordVideoDir: rawVideoDir,
					});
					const page = await context.newPage();
					const diag = attachDiagnostics(page);
					const stepShots = [];

					const captureStep = async (stepName, stepLabel) => {
						const key = `${scenario.id}__${stepName}__${matrixTag}`;
						const filename = `${key}.png`;
						const absPath = path.join(shotsDir, filename);
						const layout = await collectLayoutDiagnostics(page);
						await page.screenshot({ path: absPath, fullPage: args.fullPage, animations: "disabled" });
						stepShots.push({
							key,
							id: `${scenario.id}/${stepName}`,
							scenarioId: scenario.id,
							title: stepLabel ? `${stepName}: ${stepLabel}` : `${scenario.title} — ${stepName}`,
							category: scenario.category,
							surface: scenario.surface,
							accountConfig: scenario.accountConfig,
							description: stepLabel || scenario.description,
							theme,
							viewport,
							dpr: args.dpr,
							image: `shots/${filename}`,
							video: null,
							diagnostics: {
								...layout,
								consoleErrors: [...diag.consoleErrors],
								pageErrors: [...diag.pageErrors],
								failedRequests: [...diag.failedRequests],
							},
						});
					};

					let videoFileRel = null;
					try {
						process.stdout.write(`  • ${scenario.id} [${theme}, ${viewport.name}]... `);
						await scenario.run({
							browser,
							context,
							page,
							request: apiRequest,
							baseURL,
							viewport,
							theme,
							dpr: args.dpr,
							captureStep,
						});

						// If the scenario didn't record explicit step shots, capture its final state.
						if (stepShots.length === 0) {
							const key = `${scenario.id}__${matrixTag}`;
							const filename = `${key}.png`;
							const absPath = path.join(shotsDir, filename);
							const layout = await collectLayoutDiagnostics(page);
							await page.screenshot({ path: absPath, fullPage: args.fullPage, animations: "disabled" });
							stepShots.push({
								key,
								id: scenario.id,
								scenarioId: scenario.id,
								title: scenario.title,
								category: scenario.category,
								surface: scenario.surface,
								accountConfig: scenario.accountConfig,
								description: scenario.description,
								theme,
								viewport,
								dpr: args.dpr,
								image: `shots/${filename}`,
								video: null,
								diagnostics: {
									...layout,
									consoleErrors: [...diag.consoleErrors],
									pageErrors: [...diag.pageErrors],
									failedRequests: [...diag.failedRequests],
								},
							});
						}
						console.log(`ok (${stepShots.length} shot${stepShots.length === 1 ? "" : "s"})`);
					} catch (error) {
						console.log("FAILED");
						console.error(`    ${error.message}`);
						failures.push({ id: scenario.id, theme, viewport: viewport.name, error: error.message });
					} finally {
						const videoObj = args.video ? page.video() : null;
						await context.close();
						if (videoObj) {
							try {
								const webm = await videoObj.path();
								const mp4Name = `${scenario.id}__${matrixTag}.mp4`;
								const mp4Abs = path.join(videosDir, mp4Name);
								await convertWebmToMp4(webm, mp4Abs);
								fs.rmSync(webm, { force: true });
								videoFileRel = `videos/${mp4Name}`;
								for (const s of stepShots) {s.video = videoFileRel;}
							} catch (error) {
								console.error(`    [video convert failed] ${error.message}`);
							}
						}
					}
					shots.push(...stepShots);
				}
			}
		}

		if (args.video) {
			fs.rmSync(path.join(videosDir, "_raw"), { recursive: true, force: true });
		}

		if (args.compare) {
			const compareDir = path.isAbsolute(args.compare) ? args.compare : path.join(args.outRoot, args.compare);
			console.log(`Computing hill-climb pixel diffs against ${path.relative(ROOT, compareDir)}...`);
			await computeHillClimbDiffs(browser, { runDir, compareDir, shots });
		}

		const contactSheets = args.contactSheets
			? await buildContactSheets(browser, { runDir, shots })
			: [];

		const manifest = {
			run: runName,
			createdAt: new Date().toISOString(),
			durationMs: Date.now() - t0,
			gitCommit: gitShortSha(),
			themes: args.themes,
			viewports,
			dpr: args.dpr,
			compareTo: args.compare ? path.basename(args.compare) : null,
			contactSheets,
			failures,
			shots,
		};

		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
		writeReviewFeedHtml(runDir, manifest);
		writeRunsIndexHtml(args.outRoot);

		console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${shots.length} shots captured${failures.length ? `, ${failures.length} failed` : ""}.`);
		console.log(`  Review feed:    ${path.join(runDir, "index.html")}`);
		console.log(`  Manifest:       ${path.join(runDir, "manifest.json")}`);
		if (contactSheets.length) {
			console.log(`  Contact sheets: ${contactSheets.map((c) => path.join(runDir, c.path)).join(", ")}`);
		}
		if (failures.length > 0) {process.exitCode = 1;}
	} finally {
		await apiRequest.dispose();
		await browser.close();
		if (server) {await server.stop();}
	}
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
