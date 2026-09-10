import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/health";

export const getMetaHealth = createServerFn({ method: "GET" }).handler(() =>
  ops.getMetaHealth.run(undefined),
);
