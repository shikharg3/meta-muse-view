import { createServerFn } from "@tanstack/react-start";
import type { ReportRecipe } from "@/lib/scheduled-report";
import {
  deleteReportTemplate as deleteTemplateImpl,
  deleteScheduledReport as deleteImpl,
  fetchReportScope,
  fetchScheduledReportsPage,
  previewRecipe,
  saveReportTemplate as saveTemplateImpl,
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
  .inputValidator((d: { recipe: ReportRecipe; filename: string | null }) => d)
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
  filename: string | null;
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
  .inputValidator(
    (d: { name: string; recipe: ReportRecipe; chatId: string; filename: string | null }) => d,
  )
  .handler(({ data }) => sendDraftImpl(data));

export const saveReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string | null; name: string; recipe: ReportRecipe }) => d)
  .handler(({ data }) => saveTemplateImpl(data));

export const deleteReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteTemplateImpl(data));
