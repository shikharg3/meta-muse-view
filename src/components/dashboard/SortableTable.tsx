/* eslint-disable react-refresh/only-export-components -- the sort hook and its
   header component are one small cohesive table primitive; colocation is clearer
   than splitting, and this isn't a route module so HMR fast-refresh is moot. */
import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

/**
 * Client-side table sorting. `accessors` maps each sort key to a comparable
 * value; text keys sort A→Z first, numeric keys high→low first.
 */
export function useSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => number | string>,
  initialKey: string,
  initialDir: SortDir = "desc",
) {
  const [key, setKey] = useState(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);
  // Ref so inline-defined accessors don't churn the memo every render.
  const accRef = useRef(accessors);
  accRef.current = accessors;

  const toggle = (k: string) => {
    if (k === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setKey(k);
      // Names read better ascending; metrics read better descending. Sampling needs a row: with a
      // filter matching nothing, `rows[0]` is undefined and an accessor reading a field would throw.
      const sample = rows.length > 0 ? accessors[k]?.(rows[0]) : undefined;
      setDir(typeof sample === "string" ? "asc" : "desc");
    }
  };

  const sorted = useMemo(() => {
    const get = accRef.current[key];
    if (!get) return rows;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      const c =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    });
  }, [rows, key, dir]);

  return { sorted, key, dir, toggle };
}

/** A sortable <th>. Wire `active`/`dir`/`onSort` from a `useSort` instance. */
export function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
  className,
}: {
  label: string;
  sortKey: string;
  active: string;
  dir: SortDir;
  onSort: (k: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <th
      className={cn(
        "px-3 first:pl-5 last:pr-5 py-2.5 select-none",
        align === "right" && "text-right",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {isActive ? (
          dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  );
}
