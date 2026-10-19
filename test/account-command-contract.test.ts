import { describe, expect, it } from "vitest";
import { parseQueuedMutation } from "../src/lib/sync/account-command-parser";
import {
	describeSyncFailure,
	recordSyncFailure,
	summarizeReplayReport,
} from "../src/lib/sync/account-command-reconciliation";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
} from "../src/lib/sync/contracts";
import { createAccountEditCommand } from "../src/lib/sync/contracts";

function assertCompileTimePayloadCorrelation() {
	const fields = {
		idempotencyKey: "key",
		entityId: "1111 1111 1111 1111",
		createdAt: 1,
		attemptCount: 0,
		nextRetryAt: 1,
	};
	createAccountEditCommand("column.create", { columnId: "00000000-0000-4000-8000-000000000001" }, fields);
	// @ts-expect-error column.create cannot be paired with a reorder payload.
	createAccountEditCommand("column.create", { columnOrder: [] }, fields);
}

void assertCompileTimePayloadCorrelation;

const validPayloads = {
	"column.create": { columnId: "00000000-0000-4000-8000-000000000001" },
	"column.delete": { columnId: "00000000-0000-4000-8000-000000000001" },
	"column.restore": { columnId: "00000000-0000-4000-8000-000000000001" },
	"column.reorder": { columnOrder: ["00000000-0000-4000-8000-000000000001"] },
	"column.share": {
		columnId: "00000000-0000-4000-8000-000000000001",
		targetAccountId: "2222 2222 2222 2222",
	},
	"column.revoke": {
		columnId: "00000000-0000-4000-8000-000000000001",
		targetAccountId: "2222 2222 2222 2222",
	},
	"column.public.enable": { columnId: "00000000-0000-4000-8000-000000000001" },
	"column.public.disable": { columnId: "00000000-0000-4000-8000-000000000001" },
	"column.hide_shared": { hiddenSharedColumns: ["00000000-0000-4000-8000-000000000001"] },
} satisfies AccountCommandPayloadMap;

function storedCommand<T extends AccountCommandType>(
	opType: T,
	payload: AccountCommandPayloadMap[T],
) {
	return {
		queueId: `queue:${opType}`,
		idempotencyKey: `key:${opType}`,
		opType,
		entityId: "1111 1111 1111 1111",
		payload,
		createdAt: 1,
		attemptCount: 0,
		nextRetryAt: 1,
	};
}

describe("persisted account command parsing", () => {
	it("accepts every operation and preserves its typed payload", () => {
		for (const opType of Object.keys(validPayloads) as AccountCommandType[]) {
			const parsed = parseQueuedMutation(
				storedCommand(opType, validPayloads[opType]),
			);
			expect(parsed).toMatchObject({ opType, payload: validPayloads[opType] });
		}
	});

	it.each([
		["column.create", {}],
		["column.delete", { columnId: 42 }],
		["column.restore", { columnId: "" }],
		["column.reorder", { columnOrder: [42] }],
		["column.share", { columnId: "00000000-0000-4000-8000-000000000001", targetAccountId: "invalid" }],
		["column.revoke", { columnId: "00000000-0000-4000-8000-000000000001" }],
		["column.public.enable", { columnId: null }],
		["column.public.disable", { columnId: [] }],
		["column.hide_shared", { hiddenSharedColumns: "00000000-0000-4000-8000-000000000001" }],
		// Persisted payloads follow the server's ID contract, not just "non-empty".
		["column.delete", { columnId: "column-1" }],
		["column.reorder", { columnOrder: ["column-1"] }],
	] as const)("rejects a malformed %s payload", (opType, payload) => {
		expect(
			parseQueuedMutation({
				...storedCommand(opType, validPayloads[opType]),
				payload,
			}),
		).toBeNull();
	});

	it("rejects malformed queue metadata and unknown operations", () => {
		expect(
			parseQueuedMutation({
				...storedCommand("column.create", validPayloads["column.create"]),
				attemptCount: -1,
			}),
		).toBeNull();
		expect(
			parseQueuedMutation({
				...storedCommand("column.create", validPayloads["column.create"]),
				opType: "column.unknown",
			}),
		).toBeNull();
	});

	it("projects typed replay outcomes for state reconciliation", () => {
		const created = parseQueuedMutation(
			storedCommand("column.create", validPayloads["column.create"]),
		);
		const revoked = parseQueuedMutation(
			storedCommand("column.delete", validPayloads["column.delete"]),
		);
		expect(created).not.toBeNull();
		expect(revoked).not.toBeNull();
		if (!created || !revoked) throw new Error("Expected valid commands");

		expect(
			summarizeReplayReport({
				attempted: 2,
				acked: 1,
				retried: 0,
				dropped: 1,
				ackedCommands: [created],
				terminalFailures: [{ ...revoked, reason: "revoked" }],
				effects: [],
			}),
		).toEqual({
			ackedCreatedColumnIds: ["00000000-0000-4000-8000-000000000001"],
			failedCreatedColumnIds: [],
			accessLostColumnIds: ["00000000-0000-4000-8000-000000000001"],
			nonAccessLossFailureCount: 0,
		});
	});

	it("records a rejected command with what the server said", () => {
		const deleted = parseQueuedMutation(
			storedCommand("column.delete", validPayloads["column.delete"]),
		);
		if (!deleted) throw new Error("Expected a valid command");

		const recorded = recordSyncFailure(
			{
				...deleted,
				reason: "not_found",
				detail: { status: 404, code: "not_found", message: "Column not found" },
				failedAt: 5,
			},
			9,
		);
		expect(recorded).toEqual({
			failedAt: 5,
			opType: "column.delete",
			columnId: "00000000-0000-4000-8000-000000000001",
			reason: "not_found",
			status: 404,
			code: "not_found",
			message: "Column not found",
		});
		expect(describeSyncFailure(recorded)).toBe("column.delete: Column not found (404 not_found)");

		const bare = recordSyncFailure({ ...deleted, reason: "validation_failed" }, 9);
		expect(bare.failedAt).toBe(9);
		expect(describeSyncFailure(bare)).toBe("column.delete: validation_failed");
	});
});
