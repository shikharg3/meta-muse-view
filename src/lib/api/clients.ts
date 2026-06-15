import { createServerFn } from "@tanstack/react-start";
import {
  fetchClients,
  fetchClientDetail,
  updateClientAccounts,
  fetchClientBudgets,
} from "@/server/fns/clients";

export const listClients = createServerFn({ method: "GET" }).handler(() => fetchClients());

export const getClientDetail = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string; days: number }) => d)
  .handler(({ data }) => fetchClientDetail(data.id, data.days));

export const getClientBudgets = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => fetchClientBudgets(data));

export const mutateClientAccounts = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; action: "add" | "remove"; accountId: string }) => d)
  .handler(({ data }) => updateClientAccounts(data.id, data.action, data.accountId));
