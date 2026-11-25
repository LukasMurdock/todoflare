/**
 * Minimal RFC 9110 byte-range response builder for static media assets served
 * through a Worker (e.g. `/og.mp4`). Cloudflare Workers Static Assets does not
 * answer `Range: bytes=0-1` probes with `206 Partial Content`, which Safari,
 * iOS, and social video unfurlers require before playing an MP4.
 */

export type ParsedByteRange =
	| { kind: "ok"; start: number; end: number }
	| { kind: "unsatisfiable" }
	| { kind: "ignore" };

const SINGLE_RANGE = /^(\d*)-(\d*)$/;

export function parseByteRange(header: string, total: number): ParsedByteRange {
	const trimmed = header.trim();
	if (!/^bytes=/i.test(trimmed)) return { kind: "ignore" };
	const spec = trimmed.slice(6).trim();
	// Multi-range requests fall back cleanly to 200 OK.
	if (spec.includes(",")) return { kind: "ignore" };

	const match = SINGLE_RANGE.exec(spec);
	if (!match) return { kind: "ignore" };
	const [, startStr, endStr] = match;
	if (!startStr && !endStr) return { kind: "ignore" };
	if (total <= 0) return { kind: "unsatisfiable" };

	if (!startStr) {
		const suffix = Number(endStr);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
		const start = Math.max(0, total - suffix);
		return { kind: "ok", start, end: total - 1 };
	}

	const start = Number(startStr);
	if (!Number.isSafeInteger(start) || start < 0 || start >= total) {
		return { kind: "unsatisfiable" };
	}

	if (!endStr) {
		return { kind: "ok", start, end: total - 1 };
	}

	const rawEnd = Number(endStr);
	if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
		return { kind: "unsatisfiable" };
	}
	return { kind: "ok", start, end: Math.min(rawEnd, total - 1) };
}

function etagMatches(header: string | null, etag: string | null | undefined): boolean {
	if (!header || !etag) return false;
	const normalize = (value: string) => value.trim().replace(/^W\//, "");
	const target = normalize(etag);
	return header.split(",").some((candidate) => {
		const trimmed = candidate.trim();
		return trimmed === "*" || normalize(trimmed) === target;
	});
}

export interface ByteRangeMeta {
	contentType: string;
	etag?: string | null;
	cacheControl?: string;
}

export function serveByteRangeResponse(request: Request, bytes: Uint8Array<ArrayBuffer>, meta: ByteRangeMeta): Response {
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}

	const isHead = method === "HEAD";
	const total = bytes.byteLength;
	const cacheControl = meta.cacheControl ?? "public, max-age=3600";

	const baseHeaders = new Headers({
		"Content-Type": meta.contentType,
		"Accept-Ranges": "bytes",
		"Cache-Control": cacheControl,
	});
	if (meta.etag) baseHeaders.set("ETag", meta.etag);

	const rangeHeader = request.headers.get("Range");
	if (!rangeHeader && etagMatches(request.headers.get("If-None-Match"), meta.etag)) {
		return new Response(null, { status: 304, headers: baseHeaders });
	}

	const ifRange = request.headers.get("If-Range");
	const allowRange = !ifRange || etagMatches(ifRange, meta.etag);

	if (rangeHeader && allowRange) {
		const parsed = parseByteRange(rangeHeader, total);
		if (parsed.kind === "unsatisfiable") {
			baseHeaders.set("Content-Range", `bytes */${total}`);
			return new Response(null, { status: 416, headers: baseHeaders });
		}
		if (parsed.kind === "ok") {
			const { start, end } = parsed;
			const slice = bytes.subarray(start, end + 1);
			baseHeaders.set("Content-Range", `bytes ${start}-${end}/${total}`);
			baseHeaders.set("Content-Length", String(slice.byteLength));
			return new Response(isHead ? null : slice, { status: 206, headers: baseHeaders });
		}
	}

	baseHeaders.set("Content-Length", String(total));
	return new Response(isHead ? null : bytes, { status: 200, headers: baseHeaders });
}
