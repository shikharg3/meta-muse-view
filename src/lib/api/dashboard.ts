import { createServerFn } from "@tanstack/react-start";
import {
  fetchAccount, fetchAccounts, fetchBreakdowns, fetchBusinessSummary, fetchCampaigns, fetchCreatives, fetchOverview,
} from "@/server/fns/dashboard";

export const listAccounts = createServerFn({ method: "GET" }).handler(() => fetchAccounts());

export const getOverview = createServerFn({ method: "GET" }).handler(() => fetchOverview());

export const listCampaigns = createServerFn({ method: "GET" }).handler(() => fetchCampaigns());

export const getAccount = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => fetchAccount(data));

export const listCreatives = createServerFn({ method: "GET" }).handler(() => fetchCreatives());

export const getBreakdowns = createServerFn({ method: "GET" }).handler(() => fetchBreakdowns());

export const getBusinessSummary = createServerFn({ method: "GET" }).handler(() => fetchBusinessSummary());
