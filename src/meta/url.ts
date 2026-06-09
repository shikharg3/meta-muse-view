/** Serialize Graph API params: arrays of scalars → comma-joined; objects/arrays-of-objects → JSON. */
export function buildQuery(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const allScalar = value.every((v) => typeof v !== "object" || v === null);
      out.set(key, allScalar ? value.join(",") : JSON.stringify(value));
    } else if (typeof value === "object") {
      out.set(key, JSON.stringify(value));
    } else {
      out.set(key, String(value));
    }
  }
  return out.toString();
}
