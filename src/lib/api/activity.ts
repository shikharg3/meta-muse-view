import { createServerFn } from "@tanstack/react-start";
import { fetchActivity } from "@/server/fns/activity";

export const getActivity = createServerFn({ method: "GET" }).handler(() => fetchActivity());
