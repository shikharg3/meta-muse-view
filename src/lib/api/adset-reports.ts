import { createServerFn } from "@tanstack/react-start";
import {
  deleteAdsetReportSchedule,
  fetchAdsetReportsPage,
  previewAdsetReport as previewAdsetReportImpl,
  saveAdsetReportSchedule,
  sendAdsetReportNow,
} from "@/server/fns/adset-reports";

/** Every fn here is refused unless the request Host is in IMPORT_HOSTS and the caller is an admin. */
export const getAdsetReportsPage = createServerFn({ method: "GET" }).handler(() =>
  fetchAdsetReportsPage(),
);

export const previewAdsetReport = createServerFn({ method: "POST" })
  .inputValidator((d: { clientId: string; date: string }) => d)
  .handler(({ data }) => previewAdsetReportImpl(data));

export const saveAdsetSchedule = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      clientId: string;
      chatId: string;
      hour: number;
      minute: number;
      active: boolean;
    }) => d,
  )
  .handler(({ data }) => saveAdsetReportSchedule(data));

export const deleteAdsetSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteAdsetReportSchedule(data));

export const sendAdsetScheduleNow = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; date: string }) => d)
  .handler(({ data }) => sendAdsetReportNow(data));
