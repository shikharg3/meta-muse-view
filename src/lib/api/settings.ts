import { createServerFn } from "@tanstack/react-start";
import { fetchSettings, runTestConnection, saveCredentialsFormData, type CredsForm } from "@/server/fns/settings";

export const getSettings = createServerFn({ method: "GET" }).handler(() => fetchSettings());

export const saveCredentialsForm = createServerFn({ method: "POST" })
  .inputValidator((d: CredsForm) => d)
  .handler(({ data }) => saveCredentialsFormData(data));

export const testConnection = createServerFn({ method: "POST" }).handler(() => runTestConnection());
