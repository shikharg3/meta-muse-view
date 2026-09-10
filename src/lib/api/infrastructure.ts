import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/infrastructure";

/**
 * Server-fn wrappers for the infra registry, one per op in `src/server/api/ops/infrastructure.ts`.
 *
 * The ops hold the schemas and call the same `src/server/fns/infra/*` delegates the Base44
 * frontend reaches over HTTP, so the two frontends cannot drift. The `.inputValidator` annotations
 * below are types only — they exist so the route files keep their call-site inference; the actual
 * validation happens inside the op.
 */

// ── Reads

export const getInfraRiskMap = createServerFn({ method: "GET" }).handler(() =>
  ops.getInfraRiskMap.run(undefined),
);
export const listInfraProfiles = createServerFn({ method: "GET" }).handler(() =>
  ops.listInfraProfiles.run(undefined),
);
export const listInfraBms = createServerFn({ method: "GET" }).handler(() =>
  ops.listInfraBms.run(undefined),
);
export const listInfraAdAccounts = createServerFn({ method: "GET" }).handler(() =>
  ops.listInfraAdAccounts.run(undefined),
);
export const listUnregisteredAccounts = createServerFn({ method: "GET" }).handler(() =>
  ops.listUnregisteredAccounts.run(undefined),
);
export const listInfraPixels = createServerFn({ method: "GET" }).handler(() =>
  ops.listInfraPixels.run(undefined),
);
export const listInfraPages = createServerFn({ method: "GET" }).handler(() =>
  ops.listInfraPages.run(undefined),
);

export const getInfraBmDetail = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => ops.getInfraBmDetail.run(data));

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
  .handler(({ data }) => ops.saveInfraProfile.run(data));

export const setInfraProfileStatuses = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; statuses: string[]; reason?: string | null }) => d)
  .handler(({ data }) => ops.setInfraProfileStatuses.run(data));

export const setInfraProfileMain = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; main: boolean }) => d)
  .handler(({ data }) => ops.setInfraProfileMain.run(data));

export const deleteInfraProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteInfraProfile.run(data));

export const linkInfraProfileBm = createServerFn({ method: "POST" })
  .inputValidator((d: { profileId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraProfileBm.run(data));

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
  .handler(({ data }) => ops.saveInfraBm.run(data));

export const setInfraBmStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => ops.setInfraBmStatus.run(data));

export const getInfraBmBanPreview = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.getInfraBmBanPreview.run(data));

export const verifyInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.verifyInfraBm.run(data));

export const setInfraBmMain = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; main: boolean }) => d)
  .handler(({ data }) => ops.setInfraBmMain.run(data));

export const deleteInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteInfraBm.run(data));

export const linkInfraBmAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { bmId: string; adAccountId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraBmAdAccount.run(data));

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
  .handler(({ data }) => ops.saveInfraAdAccount.run(data));

export const deleteInfraAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteInfraAdAccount.run(data));

export const linkInfraAdAccountBm = createServerFn({ method: "POST" })
  .inputValidator((d: { adAccountId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraAdAccountBm.run(data));

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
  .handler(({ data }) => ops.saveInfraPixel.run(data));

export const setInfraPixelStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => ops.setInfraPixelStatus.run(data));

export const verifyInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.verifyInfraPixel.run(data));

export const deleteInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteInfraPixel.run(data));

export const linkInfraPixelBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pixelId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraPixelBm.run(data));

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
  .handler(({ data }) => ops.saveInfraPage.run(data));

export const setInfraPageStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => ops.setInfraPageStatus.run(data));

export const verifyInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.verifyInfraPage.run(data));

export const deleteInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteInfraPage.run(data));

export const linkInfraPageBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraPageBm.run(data));

export const linkInfraPageProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; profileId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => ops.linkInfraPageProfile.run(data));
