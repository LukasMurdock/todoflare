import worker from "../src/index";
import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseByteRange, serveByteRangeResponse } from "../src/server/http/byte-range";

const PAYLOAD = new TextEncoder().encode("0123456789abcdef");
const META = { contentType: "video/mp4", etag: '"v1"' };

async function readAscii(res: Response): Promise<string> {
	return new TextDecoder().decode(await res.arrayBuffer());
}

describe("parseByteRange", () => {
	it("parses bounded, open-ended, clamped and suffix ranges", () => {
		expect(parseByteRange("bytes=0-1", 16)).toEqual({ kind: "ok", start: 0, end: 1 });
		expect(parseByteRange("BYTES=4-", 16)).toEqual({ kind: "ok", start: 4, end: 15 });
		expect(parseByteRange("bytes=10-999", 16)).toEqual({ kind: "ok", start: 10, end: 15 });
		expect(parseByteRange("bytes=-4", 16)).toEqual({ kind: "ok", start: 12, end: 15 });
		expect(parseByteRange("bytes=-999", 16)).toEqual({ kind: "ok", start: 0, end: 15 });
	});

	it("marks out-of-bounds, inverted and zero-length suffix ranges unsatisfiable", () => {
		expect(parseByteRange("bytes=16-", 16)).toEqual({ kind: "unsatisfiable" });
		expect(parseByteRange("bytes=8-3", 16)).toEqual({ kind: "unsatisfiable" });
		expect(parseByteRange("bytes=-0", 16)).toEqual({ kind: "unsatisfiable" });
		expect(parseByteRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
	});

	it("ignores unsupported units, invalid syntax and multi-range headers", () => {
		expect(parseByteRange("items=0-1", 16)).toEqual({ kind: "ignore" });
		expect(parseByteRange("bytes=abc-def", 16)).toEqual({ kind: "ignore" });
		expect(parseByteRange("bytes=-", 16)).toEqual({ kind: "ignore" });
		expect(parseByteRange("bytes=0-1, 4-5", 16)).toEqual({ kind: "ignore" });
	});
});

describe("serveByteRangeResponse", () => {
	it("serves full 200 with Accept-Ranges and Content-Length when no Range is sent", async () => {
		const res = serveByteRangeResponse(new Request("https://example.com/og.mp4"), PAYLOAD, META);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("video/mp4");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("Content-Length")).toBe("16");
		expect(res.headers.get("ETag")).toBe('"v1"');
		expect(await readAscii(res)).toBe("0123456789abcdef");
	});

	it("serves HEAD with Content-Length, Accept-Ranges and empty body", async () => {
		const res = serveByteRangeResponse(new Request("https://example.com/og.mp4", { method: "HEAD" }), PAYLOAD, META);
		expect(res.status).toBe(200);
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("Content-Length")).toBe("16");
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it("serves Safari-style bytes=0-1 probe with 206 Partial Content", async () => {
		const res = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=0-1" } }),
			PAYLOAD,
			META,
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 0-1/16");
		expect(res.headers.get("Content-Length")).toBe("2");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(await readAscii(res)).toBe("01");
	});

	it("serves open-ended and suffix ranges as 206", async () => {
		const open = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=12-" } }),
			PAYLOAD,
			META,
		);
		expect(open.status).toBe(206);
		expect(open.headers.get("Content-Range")).toBe("bytes 12-15/16");
		expect(await readAscii(open)).toBe("cdef");

		const suffix = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=-3" } }),
			PAYLOAD,
			META,
		);
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get("Content-Range")).toBe("bytes 13-15/16");
		expect(await readAscii(suffix)).toBe("def");
	});

	it("returns 416 with total byte length for unsatisfiable ranges", () => {
		const res = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=100-200" } }),
			PAYLOAD,
			META,
		);
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe("bytes */16");
	});

	it("honors If-Range and If-None-Match", async () => {
		const stale = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=0-1", "If-Range": '"v0"' } }),
			PAYLOAD,
			META,
		);
		expect(stale.status).toBe(200);
		expect(await readAscii(stale)).toBe("0123456789abcdef");

		const fresh = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { Range: "bytes=0-1", "If-Range": '"v1"' } }),
			PAYLOAD,
			META,
		);
		expect(fresh.status).toBe(206);
		expect(await readAscii(fresh)).toBe("01");

		const notModified = serveByteRangeResponse(
			new Request("https://example.com/og.mp4", { headers: { "If-None-Match": '"v1"' } }),
			PAYLOAD,
			META,
		);
		expect(notModified.status).toBe(304);
	});
});

describe("/og.mp4 route", () => {
	it("fetches from ASSETS and returns 206 Partial Content for Range requests", async () => {
		const res = await worker.fetch(
			new Request("https://todo.tamesystems.org/og.mp4", { headers: { Range: "bytes=0-1" } }),
			{ ...env, ASSETS: { fetch: async () => new Response(PAYLOAD, {
				headers: { "Content-Type": "video/mp4", ETag: '"asset-etag"' },
			}) } },
			createExecutionContext(),
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Type")).toBe("video/mp4");
		expect(res.headers.get("Content-Range")).toBe("bytes 0-1/16");
		expect(res.headers.get("Content-Length")).toBe("2");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("ETag")).toBe('"asset-etag"');
		expect(await readAscii(res)).toBe("01");
	});
});
