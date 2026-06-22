import { createServerFn } from "@tanstack/react-start";
import { fetchSyncStatus } from "@/server/fns/status";

export const getSyncStatus = createServerFn({ method: "GET" }).handler(() => fetchSyncStatus());
