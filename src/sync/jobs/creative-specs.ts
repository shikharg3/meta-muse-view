import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { isPermanentRefusal, type BatchRefusal, type MetaClient } from "@/meta/client";
import { specImage } from "@/server/creative";

/**
 * Fetch the specs of every creative an ad uses, so its landing page and its image are knowable.
 *
 * Full creative tracking was switched off deliberately (e578ebb): paging the `adcreatives` edge with
 * an 82-field set and 1080px thumbnails over 25k creatives was the heaviest structure call we made.
 * This does NOT bring that back. It asks for three fields, by id, only for creatives not already
 * stored. It once asked only for creatives behind ACTIVE ads, which left a disapproved or paused ad
 * with no creative to show — and a disapproved ad is exactly the one an operator opens to look at.
 *
 * Cheap by construction, because a Meta creative is immutable: editing an ad mints a NEW creative id
 * rather than changing one, so a creative fetched once never needs fetching again. A creative Meta
 * refuses for good (a closed account, no permission, gone) is recorded as `raw.unavailable` and not
 * asked about again, so after the catch-up a normal cycle makes zero API calls.
 */

/** Only what a click destination and an image can be derived from (`clickDestinations`, `specImage`). */
const SPEC_FIELDS = ["id", "object_story_spec", "asset_feed_spec"] as const;

export interface CreativeSpecSync {
  /** Creative ids some stored ad uses, with no specs stored and no recorded refusal. */
  missing: number;
  fetched: number;
  /** Refused for good — recorded on the row, never asked again. */
  unavailable: number;
  /** Refused for now (throttled, Meta unwell); asked again next cycle. */
  failed: number;
}

/** Record why Meta will never return this creative, keeping whatever an older row already holds. */
async function markUnavailable(id: string, refusal: BatchRefusal): Promise<void> {
  const unavailable = {
    code: refusal.code,
    subcode: refusal.subcode,
    message: refusal.message.slice(0, 200),
    at: new Date().toISOString(),
  };
  await db
    .insert(schema.adCreatives)
    .values({ id, raw: { id, unavailable }, syncedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.adCreatives.id,
      set: {
        raw: sql`coalesce(${schema.adCreatives.raw}, '{}'::jsonb) || ${JSON.stringify({ unavailable })}::jsonb`,
        syncedAt: new Date(),
      },
    });
}

export async function syncCreativeSpecs(client: MetaClient): Promise<CreativeSpecSync> {
  // Any ad whose creative is absent, or present but with neither spec — the pre-pause rows kept
  // thumbnails only for some creatives, so presence of the row is not presence of the specs.
  const rows = await db
    .selectDistinct({ id: schema.ads.creativeId })
    .from(schema.ads)
    .leftJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(
      sql`${schema.ads.creativeId} IS NOT NULL
          AND (${schema.adCreatives.id} IS NULL
               OR (${schema.adCreatives.objectStorySpec} IS NULL AND ${schema.adCreatives.assetFeedSpec} IS NULL
                   AND NOT coalesce(${schema.adCreatives.raw} ? 'unavailable', false)))`,
    );
  const ids = rows.map((r) => r.id).filter((id): id is string => id !== null);
  const out: CreativeSpecSync = { missing: ids.length, fetched: 0, unavailable: 0, failed: 0 };
  if (ids.length === 0) return out;

  const fields = SPEC_FIELDS.join(",");
  const items = await client.batchGetItems(ids.map((id) => `${id}?fields=${fields}`));
  for (const [i, item] of items.entries()) {
    if (!item.ok) {
      if (isPermanentRefusal(item)) {
        await markUnavailable(ids[i], item);
        out.unavailable += 1;
      } else out.failed += 1;
      continue;
    }
    const body = item.body;
    if (typeof body.id !== "string") {
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

/** Hashes per `adimages` request. Meta pages that edge at 25 by default, so `limit` is set to match. */
const HASHES_PER_REQUEST = 50;

export interface CreativeImageSync {
  /** Creatives some stored ad uses, with no image URL, not asked about before. */
  missing: number;
  resolved: number;
  /** Hashes the account's image library no longer holds — recorded, so never asked again. */
  unknown: number;
  /** Accounts Meta refuses for good (closed, no permission) — recorded, so never asked again. */
  refused: number;
  /** Creatives whose account lookup failed this cycle; asked again next cycle. */
  failed: number;
  /** Creatives whose specs name no image at all (a video-only asset feed without a poster). */
  imageless: number;
}

/**
 * Give an image URL to creatives whose specs name their image only by hash — any ad's, since a
 * disapproved or paused ad is one an operator opens precisely to see what it showed.
 *
 * `syncCreativeSpecs` stores specs and nothing else, and a spec points at its image by hash — so
 * since creative tracking paused (e578ebb) every image ad created after it rendered with no
 * thumbnail, while a video ad, whose spec carries a poster URL, did. `adimages` turns hashes into
 * URLs in bulk, per account. Its `permalink_url` (`facebook.com/ads/image/?d=…`) is taken over the
 * creative's own `image_url`: that one is a signed CDN link that stops answering within days, and
 * a creative is fetched once and never again.
 *
 * The URL lands in `image_url`, the column the pre-pause sync kept each creative's image in, and
 * `image_hash` doubles as the attempted marker: a hash Meta no longer knows, or one in an account
 * Meta refuses for good, is stored with no URL and not asked about again. After the catch-up a
 * normal cycle makes no API calls.
 */
export async function syncCreativeImages(client: MetaClient): Promise<CreativeImageSync> {
  // Exactly the creatives `creativeImageUrl` has nothing for — the same four sources, read the same way.
  const rows = await db
    .selectDistinct({
      id: schema.adCreatives.id,
      accountId: schema.ads.accountId,
      objectStorySpec: schema.adCreatives.objectStorySpec,
      assetFeedSpec: schema.adCreatives.assetFeedSpec,
    })
    .from(schema.ads)
    .innerJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(
      sql`${schema.adCreatives.imageUrl} IS NULL AND ${schema.adCreatives.imageHash} IS NULL
          AND ${schema.adCreatives.thumbnailUrl} IS NULL
          AND ${schema.adCreatives.raw}->'object_story_spec'->'video_data'->>'image_url' IS NULL
          AND ${schema.adCreatives.raw}->'object_story_spec'->'link_data'->>'picture' IS NULL`,
    );
  const creatives = new Map(rows.map((r) => [r.id, r]));
  const out: CreativeImageSync = {
    missing: creatives.size,
    resolved: 0,
    unknown: 0,
    refused: 0,
    failed: 0,
    imageless: 0,
  };

  // account → hash → the creatives showing it: one uploaded image can back several creatives.
  const wanted = new Map<string, Map<string, string[]>>();
  for (const row of creatives.values()) {
    const image = specImage(row);
    if (!image) {
      out.imageless += 1;
      continue;
    }
    if ("url" in image) {
      await db
        .update(schema.adCreatives)
        .set({ imageUrl: image.url })
        .where(eq(schema.adCreatives.id, row.id));
      out.resolved += 1;
      continue;
    }
    const hashes = wanted.get(row.accountId) ?? new Map<string, string[]>();
    hashes.set(image.hash, [...(hashes.get(image.hash) ?? []), row.id]);
    wanted.set(row.accountId, hashes);
  }

  const requests: { accountId: string; hashes: Map<string, string[]> }[] = [];
  for (const [accountId, hashes] of wanted) {
    const all = [...hashes];
    for (let i = 0; i < all.length; i += HASHES_PER_REQUEST)
      requests.push({ accountId, hashes: new Map(all.slice(i, i + HASHES_PER_REQUEST)) });
  }
  if (requests.length === 0) return out;

  const items = await client.batchGetItems(
    requests.map(
      ({ accountId, hashes }) =>
        `${accountId}/adimages?hashes=${encodeURIComponent(JSON.stringify([...hashes.keys()]))}` +
        `&fields=hash,permalink_url&limit=${HASHES_PER_REQUEST}`,
    ),
  );
  for (const [i, { hashes }] of requests.entries()) {
    const item = items[i];
    const data: unknown[] | null = item.ok && Array.isArray(item.body.data) ? item.body.data : null;
    const refused = !item.ok && isPermanentRefusal(item);
    if (!data && !refused) {
      // Nothing is marked, so the next cycle asks again.
      for (const ids of hashes.values()) out.failed += ids.length;
      continue;
    }
    const permalinks = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry === null || typeof entry !== "object") continue;
      const { hash, permalink_url: url } = entry as Record<string, unknown>;
      if (typeof hash === "string" && typeof url === "string" && url) permalinks.set(hash, url);
    }
    for (const [hash, ids] of hashes) {
      const url = permalinks.get(hash) ?? null;
      await db
        .update(schema.adCreatives)
        .set({ imageHash: hash, imageUrl: url })
        .where(inArray(schema.adCreatives.id, ids));
      if (url) out.resolved += ids.length;
      else if (refused) out.refused += ids.length;
      else out.unknown += ids.length;
    }
  }
  return out;
}
