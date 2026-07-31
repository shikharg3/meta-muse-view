import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { PagePendingSkeleton } from "./components/dashboard/TableSkeleton";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Loaders hit the DB and can run for seconds. The 1000ms default swallows
    // pending UI for exactly the navigations that need it, so show it early and
    // hold it long enough to not read as a glitch.
    defaultPendingMs: 150,
    defaultPendingMinMs: 300,
    defaultPendingComponent: () => <PagePendingSkeleton />,
  });

  return router;
};
