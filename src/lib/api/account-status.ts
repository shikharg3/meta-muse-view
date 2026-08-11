import { createServerFn } from "@tanstack/react-start";
import {
  fetchStatusOverrides,
  setStatusOverride,
  clearStatusOverride,
} from "@/server/fns/account-status";

export const getStatusOverrides = createServerFn({ method: "GET" }).handler(() =>
  fetchStatusOverrides(),
);

/** Pin one board row's Account Status. Only machine-owned values are accepted server-side. */
export const pinStatusOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; status: string }) => d)
  .handler(({ data }) => setStatusOverride(data));

export const unpinStatusOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string }) => d)
  .handler(({ data }) => clearStatusOverride(data));
