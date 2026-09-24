import { z } from "zod";

/**
 * Ask the Base44 creative mirror to copy newly visible creatives into Base44's own storage.
 *
 * The mirror lives in Base44 — it spends Base44 integration credits (~1 per stored file) and writes
 * Base44 storage — but the moment there is something new to copy is here: `syncCreativeImages` is
 * what gives a new creative its image. The mirror enforces its own daily upload cap and recognises
 * an image it already holds by Meta's fingerprint and by content, so asking every cycle costs
 * nothing when there is nothing new, and can never spend past the cap however often it is asked.
 *
 * Each call is bounded in time by the mirror itself and says whether work remains; a handful per
 * cycle drains a normal day's new creatives, and anything left waits for the next cycle.
 */

/** Calls per cycle: each is bounded by the mirror's own time budget, so this bounds the step. */
const MAX_CALLS = 4;
/** Base44 kills a function at 5 minutes; give up a little sooner so the cycle hears why. */
const CALL_TIMEOUT_MS = 290_000;

const Pass = z.object({
  uploaded: z.number(),
  reused: z.number(),
  unreachable: z.number(),
  failed: z.number(),
  uploadsToday: z.number(),
  cap: z.number(),
  capReached: z.boolean(),
  more: z.boolean(),
});
const Reply = z.union([
  z.object({ ok: z.literal(true), data: Pass }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

export interface MirrorRun {
  calls: number;
  /** Files stored this run — each one an integration credit. */
  uploaded: number;
  /** Creatives filed against a file the mirror already held — no download or no upload, no credit. */
  reused: number;
  unreachable: number;
  failed: number;
  uploadsToday: number;
  cap: number;
  capReached: boolean;
}

export async function triggerCreativeMirror(
  config: { url?: string; key?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MirrorRun | null> {
  if (!config.url || !config.key) return null;
  const run: MirrorRun = {
    calls: 0,
    uploaded: 0,
    reused: 0,
    unreachable: 0,
    failed: 0,
    uploadsToday: 0,
    cap: 0,
    capReached: false,
  };
  for (;;) {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // In the body: Base44 forwards a function's body but drops custom request headers.
      body: JSON.stringify({ op: "scheduledMirror", mirrorKey: config.key }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const reply = Reply.safeParse(await res.json().catch(() => null));
    if (!reply.success) throw new Error(`creative mirror answered ${res.status} with no envelope`);
    if (!reply.data.ok) {
      throw new Error(
        `creative mirror refused (${reply.data.error.code}): ${reply.data.error.message}`,
      );
    }
    const pass = reply.data.data;
    run.calls += 1;
    run.uploaded += pass.uploaded;
    run.reused += pass.reused;
    run.unreachable += pass.unreachable;
    run.failed += pass.failed;
    run.uploadsToday = pass.uploadsToday;
    run.cap = pass.cap;
    run.capReached = pass.capReached;
    if (!pass.more || run.calls >= MAX_CALLS) return run;
  }
}
