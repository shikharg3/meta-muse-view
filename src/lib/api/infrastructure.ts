import { createServerFn } from "@tanstack/react-start";
import { fetchRiskMap } from "@/server/fns/infra/risk";
import {
  deleteProfile,
  fetchProfiles,
  linkProfileBm,
  saveProfile,
  setProfileStatuses,
} from "@/server/fns/infra/profiles";
import {
  deleteBm,
  fetchBmDetail,
  fetchBms,
  linkBmAdAccount,
  previewBmBan,
  saveBm,
  setBmStatus,
  verifyBm,
} from "@/server/fns/infra/bms";
import {
  deleteAdAccount,
  fetchAdAccounts,
  fetchUnregisteredAccounts,
  linkAdAccountBm,
  saveAdAccount,
} from "@/server/fns/infra/ad-accounts";
import {
  deletePixel,
  fetchPixels,
  linkPixelBm,
  savePixel,
  setPixelStatus,
  verifyPixel,
} from "@/server/fns/infra/pixels";
import {
  deletePage,
  fetchPages,
  linkPageBm,
  linkPageProfile,
  savePage,
  setPageStatus,
  verifyPage,
} from "@/server/fns/infra/pages";

// ── Reads

export const getInfraRiskMap = createServerFn({ method: "GET" }).handler(() => fetchRiskMap());
export const listInfraProfiles = createServerFn({ method: "GET" }).handler(() => fetchProfiles());
export const listInfraBms = createServerFn({ method: "GET" }).handler(() => fetchBms());
export const listInfraAdAccounts = createServerFn({ method: "GET" }).handler(() =>
  fetchAdAccounts(),
);
export const listUnregisteredAccounts = createServerFn({ method: "GET" }).handler(() =>
  fetchUnregisteredAccounts(),
);
export const listInfraPixels = createServerFn({ method: "GET" }).handler(() => fetchPixels());
export const listInfraPages = createServerFn({ method: "GET" }).handler(() => fetchPages());

export const getInfraBmDetail = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => fetchBmDetail(data));

// ── Profiles

export const saveInfraProfile = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      name: string;
      statuses: string[];
      geo?: string | null;
      browser?: string | null;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => saveProfile(data));

export const setInfraProfileStatuses = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; statuses: string[]; reason?: string | null }) => d)
  .handler(({ data }) => setProfileStatuses(data));

export const deleteInfraProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteProfile(data));

export const linkInfraProfileBm = createServerFn({ method: "POST" })
  .inputValidator((d: { profileId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkProfileBm(data));

// ── Business Managers

export const saveInfraBm = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      bmId: string;
      name: string;
      status: string;
      type: string;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => saveBm(data));

export const setInfraBmStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setBmStatus(data));

export const getInfraBmBanPreview = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => previewBmBan(data));

export const verifyInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyBm(data));

export const deleteInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteBm(data));

export const linkInfraBmAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { bmId: string; adAccountId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkBmAdAccount(data));

// ── Ad accounts

export const saveInfraAdAccount = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id: string;
      label?: string | null;
      usageState: string;
      notes?: string | null;
      isNew?: boolean;
    }) => d,
  )
  .handler(({ data }) => saveAdAccount(data));

export const deleteInfraAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteAdAccount(data));

export const linkInfraAdAccountBm = createServerFn({ method: "POST" })
  .inputValidator((d: { adAccountId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkAdAccountBm(data));

// ── Pixels

export const saveInfraPixel = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id: string;
      name: string;
      rootBmId: string;
      status: string;
      notes?: string | null;
      isNew?: boolean;
    }) => d,
  )
  .handler(({ data }) => savePixel(data));

export const setInfraPixelStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setPixelStatus(data));

export const verifyInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyPixel(data));

export const deleteInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deletePixel(data));

export const linkInfraPixelBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pixelId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPixelBm(data));

// ── Pages

export const saveInfraPage = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      pageId?: string | null;
      pageUrl: string;
      name: string;
      ownerProfileId: string;
      status: string;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => savePage(data));

export const setInfraPageStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setPageStatus(data));

export const verifyInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyPage(data));

export const deleteInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deletePage(data));

export const linkInfraPageBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPageBm(data));

export const linkInfraPageProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; profileId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPageProfile(data));
