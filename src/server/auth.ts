import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { generateAccountId } from "../lib/account";
import { AUTH_BASE_PATH, AUTH_ROUTES } from "../lib/api/routes";
import { credentialInventory, isProvisional, USER_VERIFICATION } from "./auth-policy";
import { rewriteJsonResponse } from "./http/responses";

export type AuthState = "provisional" | "passkey";

export interface AuthBindings {
	AUTH_DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	AUTH_ORIGIN?: string;
	AUTH_RP_ID?: string;
}

const LOCAL_ORIGINS = new Set([
	"http://localhost:5173",
	"http://localhost:4173",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:4173",
]);
const PRODUCTION_ORIGIN = "https://todo.tamesystems.org";
const DEVELOPMENT_SECRET = "todoflare-local-development-secret-do-not-use";

function recoveryCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function recoveryCodeHash(code: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

function recoveryPlugin(env: AuthBindings) {
	return {
		id: "todoflare-recovery",
		endpoints: {
			generateRecoveryCode: createAuthEndpoint(
				AUTH_ROUTES.generateRecoveryCode.path,
				{ method: AUTH_ROUTES.generateRecoveryCode.method, use: [sensitiveSessionMiddleware] },
				async (ctx) => {
					if (isProvisional(await credentialInventory(env.AUTH_DB, ctx.context.session.user.id))) {
						throw APIError.fromStatus("UNAUTHORIZED");
					}
					const code = recoveryCode();
					await env.AUTH_DB.prepare(
						'UPDATE "user" SET "recoveryCodeHash" = ?, "updatedAt" = ? WHERE "id" = ?',
					)
						.bind(await recoveryCodeHash(code), Date.now(), ctx.context.session.user.id)
						.run();
					return ctx.json({ recoveryCode: code });
				},
			),
			recoverAccount: createAuthEndpoint(
				AUTH_ROUTES.recoverAccount.path,
				{
					method: AUTH_ROUTES.recoverAccount.method,
					body: z.object({
						accountId: z.string().regex(/^\d{16}$/),
						recoveryCode: z.string().min(40).max(128),
					}),
				},
				async (ctx) => {
					const row = await env.AUTH_DB.prepare(
						'SELECT "recoveryCodeHash" FROM "user" WHERE "id" = ?',
					)
						.bind(ctx.body.accountId)
						.first<{ recoveryCodeHash: string | null }>();
					const supplied = await recoveryCodeHash(ctx.body.recoveryCode);
					if (!constantTimeEqual(row?.recoveryCodeHash ?? "0".repeat(64), supplied)) {
						throw APIError.fromStatus("UNAUTHORIZED", {
							message: "Invalid recovery credentials",
						});
					}
					const user = await ctx.context.internalAdapter.findUserById(ctx.body.accountId);
					if (!user) throw APIError.fromStatus("UNAUTHORIZED");
					// Recovery usually follows a lost or stolen device: end every
					// session it may still hold before issuing this one.
					await ctx.context.internalAdapter.deleteUserSessions(user.id);
					const session = await ctx.context.internalAdapter.createSession(user.id);
					if (!session) throw APIError.fromStatus("INTERNAL_SERVER_ERROR");
					const nextCode = recoveryCode();
					await env.AUTH_DB.prepare(
						'UPDATE "user" SET "recoveryCodeHash" = ?, "updatedAt" = ? WHERE "id" = ?',
					)
						.bind(await recoveryCodeHash(nextCode), Date.now(), user.id)
						.run();
					await setSessionCookie(ctx, { session, user });
					return ctx.json({ recoveryCode: nextCode, accountId: user.id });
				},
			),
		},
	} as const;
}

function trustedOrigin(env: AuthBindings, requestOrigin: string): string {
	const configured = env.AUTH_ORIGIN ?? PRODUCTION_ORIGIN;
	if (requestOrigin === configured || LOCAL_ORIGINS.has(requestOrigin)) {
		return requestOrigin;
	}
	return configured;
}

function relyingPartyId(env: AuthBindings, origin: string): string {
	const hostname = new URL(origin).hostname;
	if (hostname === "localhost") return "localhost";
	return env.AUTH_RP_ID ?? hostname;
}

export function createAuth(env: AuthBindings, requestOrigin: string) {
	const origin = trustedOrigin(env, requestOrigin);
	return betterAuth({
		appName: "Todoflare",
		baseURL: origin,
		basePath: AUTH_BASE_PATH,
		secret: env.BETTER_AUTH_SECRET ?? DEVELOPMENT_SECRET,
		database: env.AUTH_DB,
		trustedOrigins: [origin],
		// freshAge 0 turns off Better Auth's own 24-hour freshness check, which
		// would refuse the first passkey of a sign-up resumed a day later. The
		// recentSignIn rows of AUTH_ENDPOINTS own freshness instead (auth-policy.ts).
		session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, freshAge: 0 },
		emailAndPassword: { enabled: false },
		account: { accountLinking: { enabled: false } },
		user: {
			additionalFields: {
				authState: {
					type: "string",
					required: true,
					defaultValue: "provisional",
					input: false,
				},
				recoveryCodeHash: {
					type: "string",
					required: false,
					input: false,
				},
			},
		},
		advanced: {
			useSecureCookies: origin.startsWith("https://"),
			database: {
				generateId: ({ model }) =>
					model === "user" ? generateAccountId().replace(/\D/g, "") : crypto.randomUUID(),
			},
		},
		plugins: [
			recoveryPlugin(env),
			anonymous({
				generateRandomEmail: () =>
					`account-${crypto.randomUUID()}@accounts.invalid`,
				generateName: () => "Todoflare account",
				disableDeleteAnonymousUser: true,
			}),
			passkey({
				rpID: relyingPartyId(env, origin),
				rpName: "Todoflare",
				origin,
				authenticatorSelection: {
					residentKey: "required",
					userVerification: USER_VERIFICATION,
				},
				registration: {
					afterVerification: async ({ ctx, user }) => {
						await ctx.context.internalAdapter.updateUser(user.id, { authState: "passkey" });
					},
				},
			}),
		],
	});
}

export type TodoflareAuth = ReturnType<typeof createAuth>;

export async function cleanupAbandonedProvisionalUsers(
	env: AuthBindings,
	retentionMs = 7 * 24 * 60 * 60 * 1_000,
): Promise<number> {
	// isProvisional() in auth-policy.ts, in SQL: no passkey row.
	const result = await env.AUTH_DB.prepare(
		`DELETE FROM "user"
		 WHERE "authState" = 'provisional'
		   AND "createdAt" < ?
		   AND NOT EXISTS (
		     SELECT 1 FROM "passkey" WHERE "passkey"."userId" = "user"."id"
		   )`,
	)
		.bind(Date.now() - retentionMs)
		.run();
	return result.meta.changes;
}

export function stripSyntheticEmails(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSyntheticEmails);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "email")
			.map(([key, child]) => [key, stripSyntheticEmails(child)]),
	);
}

export function sanitizedAuthResponse(response: Response): Promise<Response> {
	return rewriteJsonResponse(response, stripSyntheticEmails);
}
