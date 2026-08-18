/**
 * cmem-verify — self-hosted replacement for cmem.ai's Pro token verifier.
 *
 * sync-hub's authenticateRequest() (workers/sync-hub/src/index.ts) composes
 * this endpoint into every sync request. HARD CONTRACT, enforced there:
 *
 *   GET  Authorization: Bearer <token>, X-User-Id: <claimed user id>
 *   2xx  -> JSON body MUST carry the canonical user id the token belongs to,
 *           as {userId} or {user_id}. sync-hub rejects (403) when it does not
 *           equal the claimed id — a 2xx alone only proves the token is valid
 *           for SOMEONE.
 *   401/403 -> invalid token. Anything else -> sync-hub answers 503.
 *
 * Single-tenant: one token, one user id, both Worker secrets. Rotating
 * SYNC_TOKEN invalidates uploads within sync-hub's 60s positive-cache bound.
 */
export interface Env {
	/** The bearer token devices present. Rotate to revoke all devices. */
	SYNC_TOKEN: string;
	/** Canonical user id this token belongs to. Must match the client's X-User-Id. */
	SYNC_USER_ID: string;
}

/**
 * Length-independent constant-time compare. Hashing first keeps the timing
 * profile flat for mismatched lengths too, which a plain byte loop leaks.
 */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(presented)),
		crypto.subtle.digest("SHA-256", enc.encode(expected)),
	]);
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
	return diff === 0;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Liveness only — never reveals whether a token is configured.
		if (url.pathname === "/healthz") return json(200, { status: "ok" });

		if (url.pathname !== "/api/pro/sync/verify") return json(404, { error: "not found" });
		if (request.method !== "GET") return json(405, { error: "use GET" });

		// A missing secret must fail CLOSED, and must not read as "bad token":
		// 503 keeps sync-hub retrying instead of telling devices they are revoked.
		if (!env.SYNC_TOKEN || !env.SYNC_USER_ID) {
			return json(503, { error: "verifier not configured" });
		}

		const auth = request.headers.get("Authorization") ?? "";
		if (!auth.startsWith("Bearer ")) return json(401, { error: "missing bearer token" });
		const token = auth.slice("Bearer ".length).trim();
		if (token.length === 0) return json(401, { error: "missing bearer token" });

		if (!(await tokensMatch(token, env.SYNC_TOKEN))) {
			return json(401, { error: "invalid token" });
		}

		// Return the canonical id unconditionally. sync-hub does the binding
		// check itself; echoing the caller's claimed id back would defeat it.
		return json(200, { userId: env.SYNC_USER_ID });
	},
} satisfies ExportedHandler<Env>;
