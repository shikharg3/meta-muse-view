import { createServerFn } from "@tanstack/react-start";
import { fetchAlerts } from "@/server/fns/alerts";

export const getAlerts = createServerFn({ method: "GET" }).handler(() => fetchAlerts());
