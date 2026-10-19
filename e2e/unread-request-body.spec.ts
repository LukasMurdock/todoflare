import { expect, test } from "@playwright/test";

// Miniflare reuses connections to workerd, and workerd closes a connection
// whose request body the Worker never read. The next request on it is reset,
// and `vite preview` then serves the SPA page instead (workers-sdk #16199,
// #16243). Requests the Worker rejects before reading the body, like an MCP
// call without a token, must not break the requests after them.
test("a request rejected before its body is read does not break the next one", async ({ baseURL }) => {
	const base = baseURL ?? "http://127.0.0.1:4173";
	const failures: string[] = [];
	const loop = async (lane: number) => {
		for (let attempt = 0; attempt < 100; attempt++) {
			const rejected = await fetch(`${base}/api/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ padding: "x".repeat(2000) }),
			});
			if (rejected.status !== 401) failures.push(`${lane}/${attempt}: rejected ${rejected.status}`);
			await rejected.text();
			const next = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`);
			if (!(next.headers.get("content-type") ?? "").includes("application/json")) failures.push(`${lane}/${attempt}: next ${next.headers.get("content-type")}`);
			await next.text();
		}
	};
	await Promise.all([0, 1, 2, 3].map(loop));
	expect(failures).toEqual([]);
});
