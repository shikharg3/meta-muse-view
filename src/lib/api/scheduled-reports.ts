import { createServerFn } from "@tanstack/react-start";
import type { ReportRecipe } from "@/lib/scheduled-report";
import {
  deleteScheduledReport as deleteImpl,
  fetchReportScope,
  fetchScheduledReportsPage,
  previewRecipe,
  saveScheduledReport as saveImpl,
  sendDraftReport as sendDraftImpl,
  sendScheduledReportNow as sendNowImpl,
  setScheduledReportActive as setActiveImpl,
} from "@/server/fns/scheduled-reports";

/** Every fn here is refused unless the request Host is in IMPORT_HOSTS and the caller is an admin. */
export const getScheduledReportsPage = createServerFn({ method: "GET" }).handler(() =>
  fetchScheduledReportsPage(),
);

export const getReportScope = createServerFn({ method: "POST" })
  .inputValidator((d: { clientId: string }) => d)
  .handler(({ data }) => fetchReportScope(data));

export const previewReportRecipe = createServerFn({ method: "POST" })
  .inputValidator((d: ReportRecipe) => d)
  .handler(({ data }) => previewRecipe(data));

export interface ScheduleInput {
  id: string | null;
  name: string;
  recipe: ReportRecipe;
  chatId: string;
  cadence: string;
  weekday: number | null;
  monthDay: number | null;
  hour: number;
  minute: number;
  active: boolean;
}

export const saveScheduledReport = createServerFn({ method: "POST" })
  .inputValidator((d: ScheduleInput) => d)
  .handler(({ data }) => saveImpl(data));

export const setScheduledReportActive = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; active: boolean }) => d)
  .handler(({ data }) => setActiveImpl(data));

export const deleteScheduledReport = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteImpl(data));

export const sendScheduledReportNow = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => sendNowImpl(data));

export const sendDraftReport = createServerFn({ method: "POST" })
  .inputValidator((d: { name: string; recipe: ReportRecipe; chatId: string }) => d)
  .handler(({ data }) => sendDraftImpl(data));
