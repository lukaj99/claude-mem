/**
 * cmem-projector — self-hosted replacement for cmem.ai's canonical projection
 * sink (POST /api/internal/sync/project).
 *
 * WHY THIS EXISTS: sync-hub's handlePushOps() calls drainProjection() after
 * every successful push. With INTERNAL_PROJECTOR_URL unset that returns 503
 * projection_not_configured — and CloudSync (src/services/sync/CloudSync.ts)
 * throws on ANY non-2xx without inspecting the response's `durable: true`.
 * The op commits in the Durable Object, the client never sees `acked`, the
 * outbox never drains, and it retries the same batch forever. So a projector
 * is REQUIRED for the push lane, not optional.
 *
 * CONTRACT (workers/sync-hub/src/index.ts fetchProjectionWithTimeout):
 *   POST, Authorization: Bearer <CMEM_INTERNAL_PROJECTOR_SECRET>
 *   body: {protocol_version, user_id, epoch, from_seq_exclusive, through_seq,
 *          ops:[{seq, body, operation_sha256}]}
 *   response: 2xx AND {protocol_version, epoch, projected_through_seq} echoed
 *   back exactly — the Hub compares all three against the page it sent
 *   (src/index.ts, projection_response_mismatch) and treats any divergence as
 *   a retryable failure. On a match it advances its checkpoint to through_seq
 *   and never resends those ops, so a success we cannot honour loses them.
 *   Persist first, answer second. Never answer optimistically.
 *
 * Writes are idempotent on (user_id, seq): the Hub legitimately replays a page
 * when a lease holder dies mid-flight, and a replay must not fail or duplicate.
 */
export interface Env {
	DB: D1Database;
	CMEM_INTERNAL_PROJECTOR_SECRET: string;
}

interface ProjectionOp {
	seq: string;
	body: string;
	operation_sha256: string;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function secretsMatch(presented: string, expected: string): Promise<boolean> {
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

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz") return json(200, { status: "ok" });
		if (url.pathname !== "/api/internal/sync/project") return json(404, { error: "not found" });
		if (request.method !== "POST") return json(405, { error: "use POST" });

		// Fail closed, and as 5xx not 4xx: a misconfigured sink must look
		// retryable to the Hub, never like a permanent rejection.
		if (!env.CMEM_INTERNAL_PROJECTOR_SECRET) {
			return json(503, { error: "projector not configured" });
		}
		const auth = request.headers.get("Authorization") ?? "";
		if (!auth.startsWith("Bearer ")) return json(401, { error: "missing bearer token" });
		if (!(await secretsMatch(auth.slice("Bearer ".length).trim(), env.CMEM_INTERNAL_PROJECTOR_SECRET))) {
			return json(401, { error: "invalid projector secret" });
		}

		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return json(400, { error: "body is not valid JSON" });
		}
		if (body.protocol_version !== 1) {
			return json(400, { error: "unsupported protocol_version" });
		}
		const userId = typeof body.user_id === "string" ? body.user_id : "";
		const epoch = typeof body.epoch === "string" ? body.epoch : "";
		const throughSeq = typeof body.through_seq === "string" ? body.through_seq : "";
		if (!userId || !epoch || !CANONICAL_DECIMAL.test(throughSeq)) {
			return json(400, { error: "missing or malformed user_id / epoch / through_seq" });
		}
		const ops = body.ops;
		if (!Array.isArray(ops) || ops.length === 0) {
			return json(400, { error: "ops must be a non-empty array" });
		}

		const statements = [];
		for (const raw of ops as ProjectionOp[]) {
			if (
				!raw || typeof raw.seq !== "string" || typeof raw.body !== "string"
				|| typeof raw.operation_sha256 !== "string" || !CANONICAL_DECIMAL.test(raw.seq)
			) {
				return json(400, { error: "malformed op in batch" });
			}
			// Idempotent on (user_id, seq) — replays after a dropped lease are
			// expected and must be a no-op, not a duplicate or a constraint error.
			statements.push(
				env.DB.prepare(
					`INSERT INTO projected_ops (user_id, seq, epoch, operation_sha256, body)
					 VALUES (?1, ?2, ?3, ?4, ?5)
					 ON CONFLICT(user_id, seq) DO UPDATE SET
					   epoch = excluded.epoch,
					   operation_sha256 = excluded.operation_sha256,
					   body = excluded.body`,
				).bind(userId, raw.seq, epoch, raw.operation_sha256, raw.body),
			);
		}
		statements.push(
			env.DB.prepare(
				`INSERT INTO projection_checkpoints (user_id, epoch, through_seq, updated_at)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(user_id) DO UPDATE SET
				   epoch = excluded.epoch,
				   through_seq = excluded.through_seq,
				   updated_at = excluded.updated_at`,
			).bind(userId, epoch, throughSeq, Date.now()),
		);

		try {
			// Durable BEFORE the 2xx. The Hub advances its checkpoint on our
			// success and will never resend these ops.
			await env.DB.batch(statements);
		} catch (e) {
			return json(503, { error: "projection write failed", detail: String(e).slice(0, 200) });
		}

		// Echo the page identity back verbatim: this is the Hub's proof that the
		// page it sent is the page we durably applied, not a stale or partial one.
		return json(200, {
			protocol_version: 1,
			epoch,
			projected_through_seq: throughSeq,
		});
	},
} satisfies ExportedHandler<Env>;
