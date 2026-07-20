import { z } from "zod";
import { normalizeAccountId, validateAccountId } from "../account";

export const accountIdContractSchema = z.string().refine(validateAccountId);
export const recordIdContractSchema = z.string().min(1).max(128);
export const timestampContractSchema = z.number().finite().nonnegative();

export const accountContractSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: accountIdContractSchema,
		columnOrder: z.array(recordIdContractSchema).max(100),
		hiddenSharedColumns: z.array(recordIdContractSchema).max(100),
		createdAt: timestampContractSchema,
	})
	.strict();

export const columnMetaContractSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: recordIdContractSchema,
		ownerId: accountIdContractSchema,
		sharedWith: z.array(accountIdContractSchema).max(100),
		publicId: z.string().regex(/^[0-9A-Za-z]{8}$/).nullable(),
		createdAt: timestampContractSchema,
	})
	.strict();

export const deletedColumnContractSchema = z
	.object({
		columnId: recordIdContractSchema,
		deletedAt: timestampContractSchema,
	})
	.strict();

export const getAccountResponseSchema = z
	.object({
		account: accountContractSchema,
		ownedColumns: z.array(columnMetaContractSchema).max(100),
		sharedColumns: z.array(columnMetaContractSchema).max(100),
		deletedColumns: z.array(deletedColumnContractSchema).max(100),
	})
	.strict()
	.superRefine((response, context) => {
		const accountId = normalizeAccountId(response.account.id);
		const orderedIds = new Set(response.account.columnOrder);
		const ownedIds = new Set<string>();
		for (const [index, column] of response.ownedColumns.entries()) {
			if (normalizeAccountId(column.ownerId) !== accountId) {
				context.addIssue({
					code: "custom",
					path: ["ownedColumns", index, "ownerId"],
					message: "Owned column metadata has a different owner",
				});
			}
			if (!orderedIds.has(column.id)) {
				context.addIssue({
					code: "custom",
					path: ["ownedColumns", index, "id"],
					message: "Owned column is not present in account order",
				});
			}
			if (ownedIds.has(column.id)) {
				context.addIssue({
					code: "custom",
					path: ["ownedColumns", index, "id"],
					message: "Owned column metadata is duplicated",
				});
			}
			ownedIds.add(column.id);
		}

		const sharedIds = new Set<string>();
		for (const [index, column] of response.sharedColumns.entries()) {
			if (!column.sharedWith.some((id) => normalizeAccountId(id) === accountId)) {
				context.addIssue({
					code: "custom",
					path: ["sharedColumns", index, "sharedWith"],
					message: "Shared column does not grant access to the account",
				});
			}
			if (sharedIds.has(column.id)) {
				context.addIssue({
					code: "custom",
					path: ["sharedColumns", index, "id"],
					message: "Shared column metadata is duplicated",
				});
			}
			sharedIds.add(column.id);
		}
	});

export const createAccountResponseSchema = z
	.object({ account: accountContractSchema })
	.strict();
