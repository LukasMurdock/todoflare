import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/agent-api.ts", import.meta.url), "utf8");
const violations = [];

if (/\bc\s*:\s*any\b|\}\)\s+as\s+any\b/.test(source)) {
	violations.push("agent OpenAPI handlers must not use any casts");
}
if (/app\.(?:get|post|put|delete|patch)\(\s*["']\/api\/agent\/v1/.test(source)) {
	violations.push("versioned agent routes must use createRoute/app.openapi");
}

if (violations.length > 0) {
	console.error(violations.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Agent route contracts are declarative and cast-free.");
}
