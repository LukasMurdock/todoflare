interface PublicIdRegistryBindings<TDurableObjectId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	PUBLIC_ID_COORDINATOR?: {
		idFromName(name: string): TDurableObjectId;
		get(id: TDurableObjectId): { fetch(request: Request): Promise<Response> };
	};
}

async function coordinatorRequest<TDurableObjectId>(
	env: PublicIdRegistryBindings<TDurableObjectId>,
	path: "claim" | "release" | "resolve",
	publicId: string,
	columnId?: string,
): Promise<Response | null> {
	if (!env.PUBLIC_ID_COORDINATOR) return null;
	const stub = env.PUBLIC_ID_COORDINATOR.get(
		env.PUBLIC_ID_COORDINATOR.idFromName(publicId),
	);
	return stub.fetch(
		new Request(`http://public-id/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicId, columnId }),
		}),
	);
}

export async function claimPublicId<TDurableObjectId>(
	env: PublicIdRegistryBindings<TDurableObjectId>,
	publicId: string,
	columnId: string,
): Promise<boolean> {
	const response = await coordinatorRequest(env, "claim", publicId, columnId);
	if (response) return response.ok;
	const mapped = await env.ACCOUNTS.get(`public:${publicId}`);
	if (mapped !== null && mapped !== columnId) return false;
	await env.ACCOUNTS.put(`public:${publicId}`, columnId);
	return true;
}

export async function releasePublicId<TDurableObjectId>(
	env: PublicIdRegistryBindings<TDurableObjectId>,
	publicId: string,
	columnId: string,
): Promise<void> {
	const response = await coordinatorRequest(env, "release", publicId, columnId);
	if (response) {
		if (!response.ok) throw new Error(`Public ID release failed: ${response.status}`);
		return;
	}
	if ((await env.ACCOUNTS.get(`public:${publicId}`)) === columnId) {
		await env.ACCOUNTS.delete(`public:${publicId}`);
	}
}

export async function resolvePublicId<TDurableObjectId>(
	env: PublicIdRegistryBindings<TDurableObjectId>,
	publicId: string,
): Promise<string | null> {
	const response = await coordinatorRequest(env, "resolve", publicId);
	if (!response) return env.ACCOUNTS.get(`public:${publicId}`);
	if (!response.ok) throw new Error(`Public ID resolve failed: ${response.status}`);
	return ((await response.json()) as { columnId: string | null }).columnId;
}
