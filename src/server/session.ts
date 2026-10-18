import { createAuth, type AuthBindings } from "./auth";

// A request can cross several authentication boundaries. Resolve and refresh it
// once, and retain Better Auth's cookies for the outer HTTP response.
async function resolveSession(request: Request, env: AuthBindings) {
	return createAuth(env, new URL(request.url).origin).api.getSession({
		headers: request.headers,
		returnHeaders: true,
	});
}

const sessions = new WeakMap<Request, ReturnType<typeof resolveSession>>();

export async function getRequestSession(request: Request, env: AuthBindings) {
	let pending = sessions.get(request);
	if (!pending) {
		pending = resolveSession(request, env);
		sessions.set(request, pending);
	}
	return (await pending).response;
}

export async function sessionResponseCookies(request: Request): Promise<string[]> {
	const pending = sessions.get(request);
	return pending ? (await pending).headers.getSetCookie() : [];
}
