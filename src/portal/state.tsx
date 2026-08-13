import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { BRANDS, type BrandFilter, type RangeKey } from "./mock";

/**
 * The two controls every portal page reads: the reporting window and the brand filter.
 *
 * Multi-brand clients (an agency holding several brands) get a filter inside their own dashboard
 * rather than separate logins — see the Track A decision. `brand === null` is the merged view.
 */
interface PortalView {
  range: RangeKey;
  brand: BrandFilter;
  brandLabel: string;
  setRange: (r: RangeKey) => void;
  setBrand: (b: BrandFilter) => void;
}

const Ctx = createContext<PortalView | null>(null);

export function PortalViewProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<RangeKey>("28d");
  const [brand, setBrand] = useState<BrandFilter>(null);
  const value = useMemo<PortalView>(
    () => ({
      range,
      brand,
      brandLabel: brand === null ? "All brands" : BRANDS.find((b) => b.id === brand)!.name,
      setRange,
      setBrand,
    }),
    [range, brand],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortalView(): PortalView {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePortalView must be used inside the /portal layout route");
  return v;
}
