import { z } from "zod";
import { runAsActor } from "@/lib/auth/actor";
import { authFailure } from "@/lib/auth/errors";
import { runAsPortalActor } from "@/portal/context";
import { resolvePortalActor } from "@/portal/scope";
import { handlePortalChat } from "@/server/agent/portal/turn";
import { audit, requireAdmin } from "@/server/fns/auth";
import type { Op } from "@/server/api/registry";

/**
 * What the portal transport would have answered, carried inside the staff op's `data`.
 *
 * The admin frontend unwraps it into the same `PortalError` a client's own call would throw, so the
 * portal's screens — including "no data linked yet" for a pending login — render unchanged.
 */
export type PortalAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

const refuse = (code: string, message: string): PortalAnswer => ({
  ok: false,
  error: { code, message },
});

/**
 * Run one client-facing op exactly as the portal user `email` would see it, for an agency admin.
 *
 * Why this is a staff op and not a field on the portal transport: that transport takes the caller's
 * identity from the `X-Actor-Email` the Base44 proxy asserts for the signed-in user. Letting it
 * accept a different address would turn "who is asking" into a request field on the one surface a
 * client can reach. Here it sits behind the staff token AND `requireAdmin()` — the same two gates as
 * every other screen in the admin console — and the client token cannot address it at all.
 *
 * Identical to the real transport, so the preview is the client's view rather than an
 * approximation of it: the address resolves through `resolvePortalActor`, the approval floor
 * answers with the same codes and sentences, and the op runs with the staff context explicitly
 * empty (`runAsActor(null)`, so any staff check reached from portal code fails closed) inside the
 * target's portal context.
 *
 * Deliberately different:
 * - **No `touchPortalActor`.** A client's "last seen" is what the admin console reports as client
 *   activity; an agency preview is not the client opening the portal.
 * - **Audited once per preview, not per op.** `portalBootstrap` is the first call the portal makes
 *   and it repeats only when its cache expires, so it marks a session; auditing every chart would
 *   bury the log in page renders.
 */
export async function runPortalOpAs(
  email: string,
  op: Pick<Op, "name" | "run"> | null,
  data: unknown,
): Promise<PortalAnswer> {
  await requireAdmin();
  if (!op) return refuse("unknown_op", "Only client-facing portal ops can be viewed as a client.");
  if (op.name === "portalBootstrap") await audit("portal.view_as", email);

  const actor = await resolvePortalActor(email);
  if (!actor) return refuse("unknown_actor", "This account has no portal access.");
  if (actor.status !== "approved") {
    return refuse(
      "not_approved",
      actor.status === "rejected"
        ? "Your portal access was withdrawn."
        : "Your portal access is not active yet.",
    );
  }

  try {
    const result = await runAsActor(null, () => runAsPortalActor(actor, () => op.run(data)));
    return { ok: true, data: result ?? null };
  } catch (e) {
    if (e instanceof z.ZodError) return refuse("invalid_input", `Invalid input for "${op.name}".`);
    const auth = authFailure(e);
    if (auth) return refuse("forbidden", auth.message);
    console.error(`[view-as] op "${op.name}" failed for ${actor.email}`, e);
    return refuse("internal", "The operation failed. Check the server log.");
  }
}

const previewTarget = z.object({ email: z.string().email() });

/**
 * One portal assistant turn exactly as the portal user `email` would get it, for an agency admin
 * previewing the portal — the streaming counterpart of `runPortalOpAs`, which answers JSON and so
 * cannot carry a turn. Served as `POST /api/v1/viewPortalAs/chat/stream` behind the staff token.
 *
 * Same gates and same actor handling as `runPortalOpAs`; the turn itself is the customer's own
 * `handlePortalChat`, so the preview is bound to the same brand check and the same tools. Different
 * in the ways a preview must be:
 * - **Audited per turn** (`portal.view_as.chat`). A turn spends money and puts words in front of
 *   an admin in the client's name; unlike a page render, each one is worth a line.
 * - **Logged with `viewed_by`** and not metered: an admin checking what a client sees must not use
 *   up that client's questions for the day.
 *
 * Refusals are HTTP statuses with the transport's envelope. The codes about the CLIENT
 * (`unknown_actor`, `inactive_client`, `brand_forbidden`) never coincide with the staff refusals
 * (`unauthorized`, `forbidden`, `not_approved`), so the admin frontend can tell "you may not
 * preview" from "this client has no such access" without a second envelope.
 */
export async function streamPortalChatAs(raw: unknown): Promise<Response> {
  let adminId: string;
  try {
    adminId = (await requireAdmin()).id;
  } catch (e) {
    const auth = authFailure(e);
    if (!auth) throw e;
    return Response.json(
      { ok: false, error: { code: "forbidden", message: auth.message } },
      { status: 403 },
    );
  }

  const target = previewTarget.safeParse(raw);
  if (!target.success) {
    return Response.json(
      { ok: false, error: { code: "bad_request", message: "Send the previewed login's email." } },
      { status: 400 },
    );
  }
  const { email } = target.data;
  await audit("portal.view_as.chat", email);

  const actor = await resolvePortalActor(email);
  if (!actor) {
    return Response.json(
      {
        ok: false,
        error: { code: "unknown_actor", message: "This account has no portal access." },
      },
      { status: 403 },
    );
  }
  if (actor.status !== "approved") {
    return Response.json(
      {
        ok: false,
        error: {
          code: "inactive_client",
          message:
            actor.status === "rejected"
              ? "This login's portal access was withdrawn."
              : "This login's portal access is not active yet.",
        },
      },
      { status: 403 },
    );
  }

  return handlePortalChat(actor, raw, adminId);
}
