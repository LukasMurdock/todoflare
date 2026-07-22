import { describe, expect, it } from "vitest";
import {
	checksumColumnBackupPayload,
	columnBackupPayloadSchema,
	parseAndVerifyColumnBackup,
} from "../src/server/column-backup-payload";

const basePayload = {
	schemaVersion: 1 as const,
	columnId: "column-1",
	snapshotAt: 10,
	meta: {
		schemaVersion: 1 as const,
		id: "column-1",
		ownerId: "1111 2222 3333 4444",
		sharedWith: [],
		publicId: null,
		createdAt: 1,
	},
	yjs: [0, 0],
};

describe("column backup payload", () => {
	it("parses and verifies a current backup", async () => {
		const checksum = await checksumColumnBackupPayload(basePayload);
		const result = await parseAndVerifyColumnBackup(
			JSON.stringify({ ...basePayload, checksum }),
			"column-1",
		);
		expect(result).toMatchObject({ ok: true, payload: basePayload });
	});

	it("distinguishes malformed JSON, invalid shape, and checksum mismatch", async () => {
		expect(await parseAndVerifyColumnBackup("{", "column-1")).toEqual({
			ok: false,
			code: "invalid_backup_json",
		});
		expect(
			await parseAndVerifyColumnBackup(
				JSON.stringify({ ...basePayload, checksum: "not-a-checksum" }),
				"column-1",
			),
		).toEqual({ ok: false, code: "invalid_backup_payload" });
		const checksum = "0".repeat(64);
		expect(
			await parseAndVerifyColumnBackup(
				JSON.stringify({ ...basePayload, checksum }),
				"column-1",
			),
		).toEqual({ ok: false, code: "backup_checksum_mismatch" });
	});

	it("rejects invalid byte values and mismatched metadata", () => {
		expect(
			columnBackupPayloadSchema.safeParse({
				...basePayload,
				yjs: [256],
				checksum: "0".repeat(64),
			}).success,
		).toBe(false);
		expect(
			columnBackupPayloadSchema.safeParse({
				...basePayload,
				meta: { ...basePayload.meta, id: "another-column" },
				checksum: "0".repeat(64),
			}).success,
		).toBe(false);
	});
});
