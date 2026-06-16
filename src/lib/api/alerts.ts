import { createServerFn } from "@tanstack/react-start";
import { fetchAlerts } from "@/server/fns/alerts";
import { alertSettings, sendTestAlert as runTestAlert } from "@/sync/alerts";

export const getAlerts = createServerFn({ method: "GET" }).handler(() => fetchAlerts());

export const getAlertSettings = createServerFn({ method: "GET" }).handler(() => alertSettings());

export const sendTestAlert = createServerFn({ method: "POST" }).handler(() => runTestAlert());
