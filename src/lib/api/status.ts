import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/status";

export const getSyncStatus = createServerFn({ method: "GET" }).handler(() =>
  ops.getSyncStatus.run(undefined),
);
