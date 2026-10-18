import { accountRequestHeaders } from "../account-request-headers";
import { API_ROUTES, routePath } from "../api/routes";
import {
	ColumnSocketAuthorizationError,
	ColumnSocketProvisioningError,
} from "./column-session-machine";

interface ColumnSocketUrlRequest {
	accountId: string;
	columnId: string;
	signal?: AbortSignal;
	/**
	 * Whether a column.create for this column is still queued. Checked after the
	 * response arrives, since the create may be acknowledged meanwhile.
	 */
	hasPendingCreate(): boolean;
	fetch?: typeof globalThis.fetch;
	location?: Pick<Location, "protocol" | "host">;
}

/**
 * Exchanges the account session for a single-use WebSocket ticket and returns
 * the socket URL. A 403/404 for a column whose creation is still queued means
 * "not provisioned yet" rather than "access lost".
 */
export async function fetchColumnSocketUrl({
	accountId,
	columnId,
	signal,
	hasPendingCreate,
	fetch: fetchRequest = globalThis.fetch.bind(globalThis),
	location = window.location,
}: ColumnSocketUrlRequest): Promise<string> {
	const response = await fetchRequest(
		routePath(API_ROUTES.columnWsTicket.path, { id: columnId }),
		{
			method: API_ROUTES.columnWsTicket.method,
			signal,
			headers: accountRequestHeaders(accountId),
		},
	);
	if ([403, 404].includes(response.status) && hasPendingCreate()) {
		throw new ColumnSocketProvisioningError(response.status);
	}
	if ([401, 403, 404].includes(response.status)) {
		throw new ColumnSocketAuthorizationError(response.status);
	}
	if (!response.ok) throw new Error(`WebSocket ticket failed: ${response.status}`);
	const payload = (await response.json()) as { ticket?: unknown };
	if (typeof payload.ticket !== "string") {
		throw new Error("WebSocket ticket response is invalid");
	}
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const path = routePath(API_ROUTES.columnWs.path, { id: columnId });
	return `${protocol}//${location.host}${path}?ticket=${encodeURIComponent(payload.ticket)}`;
}
