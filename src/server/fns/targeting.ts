import { db, schema } from "@/db/client";
import { desc, isNotNull, eq } from "drizzle-orm";

export interface TargetingRow {
  id: string;
  name: string;
  accountId: string;
  accountName: string | null;
  optimizationGoal: string | null;
  countries: string[];
  ageMin: number | null;
  ageMax: number | null;
  genders: string;
  customAudiences: number;
  excludedAudiences: number;
  interests: string[];
  advantageAudience: boolean;
}

function genderLabel(g: unknown): string {
  const arr = Array.isArray(g) ? g.map(Number) : [];
  if (arr.length === 0 || (arr.includes(1) && arr.includes(2))) return "All";
  if (arr.includes(1)) return "Male";
  if (arr.includes(2)) return "Female";
  return "All";
}

/** Pull interest/behavior names out of flexible_spec blocks. */
function interestNames(spec: unknown): string[] {
  if (!Array.isArray(spec)) return [];
  const out: string[] = [];
  for (const block of spec) {
    const b = block as Record<string, unknown>;
    for (const key of ["interests", "behaviors", "life_events", "industries"]) {
      const arr = b[key];
      if (Array.isArray(arr))
        for (const x of arr) {
          const n = (x as Record<string, unknown>).name;
          if (typeof n === "string") out.push(n);
        }
    }
  }
  return [...new Set(out)];
}

/** Ad-set targeting definitions, summarised for the Targeting inspector. */
export async function fetchTargeting(limit = 300): Promise<TargetingRow[]> {
  const rows = await db
    .select({
      id: schema.adSets.id,
      name: schema.adSets.name,
      accountId: schema.adSets.accountId,
      accountName: schema.accounts.name,
      optimizationGoal: schema.adSets.optimizationGoal,
      targeting: schema.adSets.targeting,
    })
    .from(schema.adSets)
    .leftJoin(schema.accounts, eq(schema.adSets.accountId, schema.accounts.id))
    .where(isNotNull(schema.adSets.targeting))
    .orderBy(desc(schema.adSets.createdTime))
    .limit(limit);
  return rows.map((r) => {
    const t = (r.targeting ?? {}) as Record<string, unknown>;
    const geo = (t.geo_locations ?? {}) as Record<string, unknown>;
    const automation = (t.targeting_automation ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      accountId: r.accountId,
      accountName: r.accountName,
      optimizationGoal: r.optimizationGoal,
      countries: Array.isArray(geo.countries) ? (geo.countries as string[]) : [],
      ageMin: typeof t.age_min === "number" ? t.age_min : null,
      ageMax: typeof t.age_max === "number" ? t.age_max : null,
      genders: genderLabel(t.genders),
      customAudiences: Array.isArray(t.custom_audiences) ? t.custom_audiences.length : 0,
      excludedAudiences: Array.isArray(t.excluded_custom_audiences)
        ? t.excluded_custom_audiences.length
        : 0,
      interests: interestNames(t.flexible_spec).slice(0, 8),
      advantageAudience: Number(automation.advantage_audience) === 1,
    };
  });
}
