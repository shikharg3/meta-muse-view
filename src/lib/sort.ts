/**
 * Generic table sort. Numbers sort numerically, strings via `localeCompare` (so ISO dates like
 * "2026-06-01" sort chronologically). Missing values (null/undefined/"") always sink to the bottom
 * regardless of direction — e.g. sorting by a disabled-date keeps live accounts (no date) last.
 */
export function sortByKey<T>(list: readonly T[], key: keyof T, dir: "asc" | "desc"): T[] {
  return [...list].sort((a, b) => {
    const av = a[key] as string | number | null | undefined;
    const bv = b[key] as string | number | null | undefined;
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
    const cmp =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return dir === "asc" ? cmp : -cmp;
  });
}
