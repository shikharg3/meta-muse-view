import { createServerFn } from "@tanstack/react-start";
import { fetchMetaHealth } from "@/server/fns/health";

export const getMetaHealth = createServerFn({ method: "GET" }).handler(() => fetchMetaHealth());
