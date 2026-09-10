import { z } from "zod";

/**
 * The operation registry: one entry per callable backend operation, shared by both transports.
 *
 * `src/lib/api/*.ts` (the TanStack server fns the in-repo UI calls) and `src/server/api/http.ts`
 * (the HTTP surface the Base44 frontend calls through its proxy function) both dispatch through
 * these. That is the point: an op is defined once, validates its input once, and cannot drift
 * between the two frontends.
 *
 * Op names are the historical `src/lib/api` export names — `getOverview`, `saveInfraProfile`. Not
 * a REST noun hierarchy: the only caller is generated code, a 1:1 name mapping makes the cutover
 * reviewable, and the registry rejects duplicates so the flat namespace stays honest.
 */

export type OpMode = "read" | "write";

export interface Op<O = unknown> {
  readonly name: string;
  /** `read` never mutates and is safe to retry or cache; `write` may. Advisory metadata only. */
  readonly mode: OpMode;
  /** Validate `raw`, then execute. Both transports go through here, so input is always parsed. */
  run(raw: unknown): Promise<O>;
}

interface SpecWithInput<I, O> {
  name: string;
  mode: OpMode;
  /**
   * The parsed type `I` is the schema's OUTPUT; its input side is `unknown` because that is what
   * actually arrives — a JSON body over HTTP, an untyped `data` from a server fn. Writing
   * `z.ZodType<I>` instead pins Input to Output, which makes any schema with a `.transform()`
   * (every `scalarString` op) infer `I` as the pre-transform union and mistype the handler.
   */
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  handler: (input: I) => Promise<O>;
}

interface SpecWithoutInput<O> {
  name: string;
  mode: OpMode;
  handler: () => Promise<O>;
}

export function defineOp<I, O>(spec: SpecWithInput<I, O>): Op<O>;
export function defineOp<O>(spec: SpecWithoutInput<O>): Op<O>;
export function defineOp<I, O>(spec: SpecWithInput<I, O> | SpecWithoutInput<O>): Op<O> {
  return {
    name: spec.name,
    mode: spec.mode,
    async run(raw) {
      if (!("input" in spec)) return spec.handler();
      return spec.handler(spec.input.parse(raw));
    },
  };
}

/**
 * True when `value` is an op. Used to collect them out of module namespaces.
 *
 * A guard rather than a marker property so an op stays a plain object: the check has to work on
 * every export of every ops module, including the exported schemas and types.
 */
export function isOp(value: unknown): value is Op {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "run" in value &&
    typeof value.run === "function"
  );
}

// ── Shared input schemas ───────────────────────────────────────────────────────────────────────

/**
 * Inputs that were bare scalars over the server-fn boundary (`(id: string) => id`).
 *
 * The HTTP body is JSON, and a top-level scalar is a needless special case in every generated
 * client, so the wire shape is `{ value }` and the schema unwraps it. `z.union` also accepts the
 * bare scalar, which is what the in-repo server fns still pass.
 */
export const scalarString = z
  .union([z.string(), z.object({ value: z.string() })])
  .transform((v) => (typeof v === "string" ? v : v.value));

/** Same, for the one op whose scalar is optional (`adminListConversations`: absent = all users). */
export const optionalScalarString = z
  .union([z.string(), z.null(), z.undefined(), z.object({ value: z.string().optional() })])
  .transform((v) => (v && typeof v === "object" ? v.value : (v ?? undefined)));
