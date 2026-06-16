function genderLabel(g: unknown): string {
  const arr = Array.isArray(g) ? g.map(Number) : [];
  if (arr.length === 0 || (arr.includes(1) && arr.includes(2))) return "All";
  if (arr.includes(1)) return "Male";
  if (arr.includes(2)) return "Female";
  return "All";
}

/** Compact one-line audience summary from an ad set's targeting spec (geo · age · gender · audiences). */
export function summarizeTargeting(targeting: unknown): string | null {
  if (!targeting || typeof targeting !== "object") return null;
  const t = targeting as Record<string, unknown>;
  const geo = (t.geo_locations ?? {}) as Record<string, unknown>;
  const automation = (t.targeting_automation ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(geo.countries) && geo.countries.length) {
    const countries = geo.countries as string[];
    parts.push(
      countries.slice(0, 4).join(", ") + (countries.length > 4 ? ` +${countries.length - 4}` : ""),
    );
  }
  const ageMin = typeof t.age_min === "number" ? t.age_min : null;
  const ageMax = typeof t.age_max === "number" ? t.age_max : null;
  if (ageMin != null || ageMax != null) parts.push(`${ageMin ?? 13}-${ageMax ?? 65}`);
  parts.push(genderLabel(t.genders));
  const customAudiences = Array.isArray(t.custom_audiences) ? t.custom_audiences.length : 0;
  if (customAudiences > 0) parts.push(`${customAudiences} custom aud.`);
  if (Number(automation.advantage_audience) === 1) parts.push("Advantage+");
  return parts.length ? parts.join(" · ") : null;
}
