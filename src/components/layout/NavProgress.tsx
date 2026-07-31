import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * Delay before the bar appears. Navigations that settle faster than this never
 * paint the indicator, so cached/instant routes don't flash.
 */
const SHOW_DELAY_MS = 120;

/**
 * Thin indeterminate bar pinned above the whole app shell. Driven straight off
 * the router's load state (`isLoading` flips true in `beforeLoad`, false once
 * every match is ready), so it covers sidebar nav, table-row links, and
 * search-param navigations alike.
 */
export function NavProgress() {
  const isNavigating = useRouterState({
    select: (s) => s.isLoading || s.status === "pending",
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isNavigating) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isNavigating]);

  if (!visible) return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-busy="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5 overflow-hidden bg-primary/20"
    >
      <div className="h-full w-2/5 rounded-full bg-primary animate-nav-progress" />
    </div>
  );
}
