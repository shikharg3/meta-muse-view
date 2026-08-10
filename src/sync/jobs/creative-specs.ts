import { eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { MetaClient } from "@/meta/client";

/**
 * Fetch the link specs for creatives behind live ads, so an ad's landing page is knowable.
 *
 * Full creative tracking was switched off deliberately (e578ebb): paging the `adcreatives` edge with
 * an 82-field set and 1080px thumbnails over 25k creatives was the heaviest structure call we made.
 * This does NOT bring that back. It asks for two fields, by id, only for creatives referenced by an
 * ACTIVE ad and not already stored — which is what the Destination URL column needs and nothing more.
 *
 * Cheap by construction, because a Meta creative is immutable: editing an ad mints a NEW creative id
 * rather than changing one, so a creative fetched once never needs fetching again. After the initial
 * catch-up this job costs one query and zero API calls on a normal cycle.
 */

/** Only what a click destination can be derived from (see `clickDestinations`). */
const SPEC_FIELDS = ["id", "object_story_spec", "asset_feed_spec"] as const;

export interface CreativeSpecSync {
  /** Creative ids referenced by an ACTIVE ad with no specs stored. */
  missing: number;
  fetched: number;
  /** Ids Meta would not return (deleted creative, or no permission). */
  failed: number;
}

export async function syncCreativeSpecs(client: MetaClient): Promise<CreativeSpecSync> {
  // An ACTIVE ad whose creative is absent, or present but with neither spec — the pre-pause rows kept
  // thumbnails only for some creatives, so presence of the row is not presence of the specs.
  const rows = await db
    .selectDistinct({ id: schema.ads.creativeId })
    .from(schema.ads)
    .leftJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(
      sql`${schema.ads.effectiveStatus} = 'ACTIVE' AND ${schema.ads.creativeId} IS NOT NULL
          AND (${schema.adCreatives.id} IS NULL
               OR (${schema.adCreatives.objectStorySpec} IS NULL AND ${schema.adCreatives.assetFeedSpec} IS NULL))`,
    );
  const ids = rows.map((r) => r.id).filter((id): id is string => id !== null);
  const out: CreativeSpecSync = { missing: ids.length, fetched: 0, failed: 0 };
  if (ids.length === 0) return out;

  const fields = SPEC_FIELDS.join(",");
  const bodies = await client.batchGet(ids.map((id) => `${id}?fields=${fields}`));
  for (const [i, body] of bodies.entries()) {
    if (!body || typeof body.id !== "string") {
      out.failed += 1;
      continue;
    }
    const oss = body.object_story_spec ?? null;
    const afs = body.asset_feed_spec ?? null;
    await db
      .insert(schema.adCreatives)
      .values({
        id: ids[i],
        objectStorySpec: oss,
        assetFeedSpec: afs,
        // Only for a row created here: never overwrite a pre-pause `raw`, which the ad drill-down
        // still reads thumbnails out of.
        raw: body,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.adCreatives.id,
        set: { objectStorySpec: oss, assetFeedSpec: afs, syncedAt: new Date() },
      });
    out.fetched += 1;
  }
  return out;
}

/** Creatives on ACTIVE ads still missing their specs — for reporting the coverage gap. */
export async function creativeSpecGap(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(DISTINCT ${schema.ads.creativeId})` })
    .from(schema.ads)
    .leftJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(
      sql`${schema.ads.effectiveStatus} = 'ACTIVE' AND ${schema.ads.creativeId} IS NOT NULL
          AND (${schema.adCreatives.id} IS NULL
               OR (${schema.adCreatives.objectStorySpec} IS NULL AND ${schema.adCreatives.assetFeedSpec} IS NULL))`,
    );
  return Number(r?.n ?? 0);
}
