import { test, expect } from "bun:test";
import { triggerCreativeMirror } from "./creative-mirror";

const pass = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    uploaded: 3,
    reused: 2,
    unreachable: 1,
    failed: 0,
    uploadsToday: 10,
    cap: 100,
    capReached: false,
    more: false,
    ...over,
  },
});

function fakeMirror(replies: unknown[]) {
  const calls: { key: unknown; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ key: body.mirrorKey, body });
    return new Response(JSON.stringify(replies[Math.min(calls.length - 1, replies.length - 1)]));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const config = { url: "https://mirror.example/functions/creatives", key: "k".repeat(32) };

test("asks again while the mirror has work left, then reports the run as a whole", async () => {
  const { calls, fetchImpl } = fakeMirror([
    pass({ more: true }),
    pass({ uploadsToday: 13, more: false }),
  ]);
  const run = await triggerCreativeMirror(config, fetchImpl);
  expect(calls).toHaveLength(2);
  // The key is the only thing that lets this call spend credits; it must travel on every call.
  expect(calls.every((c) => c.key === config.key)).toBe(true);
  expect(calls[0].body.op).toBe("scheduledMirror");
  expect(run).toMatchObject({ calls: 2, uploaded: 6, reused: 4, unreachable: 2, uploadsToday: 13 });
});

test("a mirror that always has more is still asked a bounded number of times", async () => {
  const { calls, fetchImpl } = fakeMirror([pass({ more: true })]);
  await triggerCreativeMirror(config, fetchImpl);
  expect(calls.length).toBeLessThanOrEqual(4);
});

test("a refusal surfaces, and an unconfigured mirror is never called", async () => {
  const refused = fakeMirror([{ ok: false, error: { code: "forbidden", message: "bad key" } }]);
  await expect(triggerCreativeMirror(config, refused.fetchImpl)).rejects.toThrow("forbidden");

  const idle = fakeMirror([pass()]);
  expect(await triggerCreativeMirror({ url: config.url }, idle.fetchImpl)).toBeNull();
  expect(idle.calls).toHaveLength(0);
});
