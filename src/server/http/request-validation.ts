import { type Context } from "hono";
import { z } from "zod";
import { columnIdContractSchema, publicIdContractSchema } from "../../lib/api/account-contract";
import { type Bindings } from "../bindings";

export type RequestValidationResult<T> =
	| { ok: true; data: T }
	| { ok: false; response: Response };

export function invalidRequestResponse(
	c: Context<{ Bindings: Bindings }>,
	error: z.ZodError,
): Response {
	return c.json(
		{
			error: "invalid_request",
			code: "invalid_request",
			issues: error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			})),
		},
		400,
	);
}

export function validateRequestInput<TSchema extends z.ZodType>(
	c: Context<{ Bindings: Bindings }>,
	schema: TSchema,
	input: unknown,
): RequestValidationResult<z.output<TSchema>> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, response: invalidRequestResponse(c, parsed.error) };
	}
	return { ok: true, data: parsed.data };
}

export async function validateJsonBody<TSchema extends z.ZodType>(
	c: Context<{ Bindings: Bindings }>,
	schema: TSchema,
	options?: { optional?: boolean },
): Promise<RequestValidationResult<z.output<TSchema>>> {
	let input: unknown;
	try {
		const raw = await c.req.raw.clone().text();
		input = options?.optional && raw.trim() === "" ? {} : JSON.parse(raw);
	} catch {
		return validateRequestInput(c, schema, undefined);
	}
	return validateRequestInput(c, schema, input);
}

export const columnPathSchema = z.object({ id: columnIdContractSchema }).strict();

export const publicPathSchema = z.object({ publicId: publicIdContractSchema }).strict();
