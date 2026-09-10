import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/activity";

export const getActivity = createServerFn({ method: "GET" }).handler(() =>
  ops.getActivity.run(undefined),
);
