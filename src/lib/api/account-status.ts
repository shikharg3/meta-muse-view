import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/account-status";

export const getStatusOverrides = createServerFn({ method: "GET" }).handler(() =>
  ops.getStatusOverrides.run(undefined),
);

/** Pin one board row's Account Status. Only machine-owned values are accepted server-side. */
export const pinStatusOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; status: string }) => d)
  .handler(({ data }) => ops.pinStatusOverride.run(data));

export const unpinStatusOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string }) => d)
  .handler(({ data }) => ops.unpinStatusOverride.run(data));
