import { z } from "zod";
import {
  deleteAdAccount,
  fetchAdAccounts,
  fetchUnregisteredAccounts,
  linkAdAccountBm,
  saveAdAccount,
} from "@/server/fns/infra/ad-accounts";
import {
  deleteBm,
  fetchBmDetail,
  fetchBms,
  linkBmAdAccount,
  previewBmBan,
  saveBm,
  setBmMain,
  setBmStatus,
  verifyBm,
} from "@/server/fns/infra/bms";
import {
  deletePage,
  fetchPages,
  linkPageBm,
  linkPageProfile,
  savePage,
  setPageStatus,
  verifyPage,
} from "@/server/fns/infra/pages";
import {
  deletePixel,
  fetchPixels,
  linkPixelBm,
  savePixel,
  setPixelStatus,
  verifyPixel,
} from "@/server/fns/infra/pixels";
import {
  deleteProfile,
  fetchProfiles,
  linkProfileBm,
  saveProfile,
  setProfileMain,
  setProfileStatuses,
} from "@/server/fns/infra/profiles";
import { fetchRiskMap } from "@/server/fns/infra/risk";
import { defineOp, scalarString } from "../registry";
import { idOnly, linkAction, nullableText, statusString } from "../schemas";

/**
 * Infrastructure registry ops — profiles, business managers, ad accounts, pixels, pages.
 *
 * Every delegate opens with `requireAdmin()`, which throws, so no op here adds a check of its own:
 * duplicating the guard would only change *where* the same rejection comes from.
 *
 * The `save*` schemas deliberately do not enforce non-empty strings on fields the delegate already
 * validates (`name`, `pageUrl`, a pixel's or ad account's id). Those delegates answer bad input
 * with `{ok:false,error:"Name is required"}`, and the UI renders that string inline; a `min(1)`
 * here would turn the same request into a thrown validation error instead.
 */

// ── Reads

export const getInfraRiskMap = defineOp({
  name: "getInfraRiskMap",
  mode: "read",
  handler: () => fetchRiskMap(),
});

export const listInfraProfiles = defineOp({
  name: "listInfraProfiles",
  mode: "read",
  handler: () => fetchProfiles(),
});

export const listInfraBms = defineOp({
  name: "listInfraBms",
  mode: "read",
  handler: () => fetchBms(),
});

export const listInfraAdAccounts = defineOp({
  name: "listInfraAdAccounts",
  mode: "read",
  handler: () => fetchAdAccounts(),
});

export const listUnregisteredAccounts = defineOp({
  name: "listUnregisteredAccounts",
  mode: "read",
  handler: () => fetchUnregisteredAccounts(),
});

export const listInfraPixels = defineOp({
  name: "listInfraPixels",
  mode: "read",
  handler: () => fetchPixels(),
});

export const listInfraPages = defineOp({
  name: "listInfraPages",
  mode: "read",
  handler: () => fetchPages(),
});

export const getInfraBmDetail = defineOp({
  name: "getInfraBmDetail",
  mode: "read",
  input: scalarString,
  handler: (id) => fetchBmDetail(id),
});

/** Declared POST-shaped input but purely a projection: banning happens through `setInfraBmStatus`. */
export const getInfraBmBanPreview = defineOp({
  name: "getInfraBmBanPreview",
  mode: "read",
  input: idOnly,
  handler: (input) => previewBmBan(input),
});

// ── Profiles

export const saveInfraProfile = defineOp({
  name: "saveInfraProfile",
  mode: "write",
  input: z.object({
    // Absent, null or empty means create — the delegate branches on truthiness, and the edit form
    // sends `""` for a new row.
    id: z.string().nullable().optional(),
    name: z.string(),
    statuses: z.array(statusString),
    geo: nullableText,
    browser: nullableText,
    notes: nullableText,
  }),
  handler: (input) => saveProfile(input),
});

export const setInfraProfileStatuses = defineOp({
  name: "setInfraProfileStatuses",
  mode: "write",
  input: z.object({
    id: z.string().min(1),
    statuses: z.array(statusString),
    reason: nullableText,
  }),
  handler: (input) => setProfileStatuses(input),
});

export const setInfraProfileMain = defineOp({
  name: "setInfraProfileMain",
  mode: "write",
  input: z.object({ id: z.string().min(1), main: z.boolean() }),
  handler: (input) => setProfileMain(input),
});

export const deleteInfraProfile = defineOp({
  name: "deleteInfraProfile",
  mode: "write",
  input: idOnly,
  handler: (input) => deleteProfile(input),
});

export const linkInfraProfileBm = defineOp({
  name: "linkInfraProfileBm",
  mode: "write",
  input: z.object({
    profileId: z.string().min(1),
    bmId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkProfileBm(input),
});

// ── Business Managers

export const saveInfraBm = defineOp({
  name: "saveInfraBm",
  mode: "write",
  input: z.object({
    id: z.string().nullable().optional(),
    bmId: z.string(),
    name: z.string(),
    status: statusString,
    type: z.string(),
    notes: nullableText,
  }),
  handler: (input) => saveBm(input),
});

export const setInfraBmStatus = defineOp({
  name: "setInfraBmStatus",
  mode: "write",
  input: z.object({ id: z.string().min(1), status: statusString, reason: nullableText }),
  handler: (input) => setBmStatus(input),
});

export const verifyInfraBm = defineOp({
  name: "verifyInfraBm",
  mode: "write",
  input: idOnly,
  handler: (input) => verifyBm(input),
});

export const setInfraBmMain = defineOp({
  name: "setInfraBmMain",
  mode: "write",
  input: z.object({ id: z.string().min(1), main: z.boolean() }),
  handler: (input) => setBmMain(input),
});

export const deleteInfraBm = defineOp({
  name: "deleteInfraBm",
  mode: "write",
  input: idOnly,
  handler: (input) => deleteBm(input),
});

export const linkInfraBmAdAccount = defineOp({
  name: "linkInfraBmAdAccount",
  mode: "write",
  input: z.object({
    bmId: z.string().min(1),
    adAccountId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkBmAdAccount(input),
});

// ── Ad accounts

export const saveInfraAdAccount = defineOp({
  name: "saveInfraAdAccount",
  mode: "write",
  input: z.object({
    // The Meta `act_…` id, supplied by the operator on create; the delegate owns the format check.
    id: z.string(),
    label: nullableText,
    usageState: statusString,
    notes: nullableText,
    isNew: z.boolean().optional(),
  }),
  handler: (input) => saveAdAccount(input),
});

export const deleteInfraAdAccount = defineOp({
  name: "deleteInfraAdAccount",
  mode: "write",
  input: idOnly,
  handler: (input) => deleteAdAccount(input),
});

export const linkInfraAdAccountBm = defineOp({
  name: "linkInfraAdAccountBm",
  mode: "write",
  input: z.object({
    adAccountId: z.string().min(1),
    bmId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkAdAccountBm(input),
});

// ── Pixels

export const saveInfraPixel = defineOp({
  name: "saveInfraPixel",
  mode: "write",
  input: z.object({
    id: z.string(),
    name: z.string(),
    rootBmId: z.string(),
    status: statusString,
    notes: nullableText,
    isNew: z.boolean().optional(),
  }),
  handler: (input) => savePixel(input),
});

export const setInfraPixelStatus = defineOp({
  name: "setInfraPixelStatus",
  mode: "write",
  input: z.object({ id: z.string().min(1), status: statusString, reason: nullableText }),
  handler: (input) => setPixelStatus(input),
});

export const verifyInfraPixel = defineOp({
  name: "verifyInfraPixel",
  mode: "write",
  input: idOnly,
  handler: (input) => verifyPixel(input),
});

export const deleteInfraPixel = defineOp({
  name: "deleteInfraPixel",
  mode: "write",
  input: idOnly,
  handler: (input) => deletePixel(input),
});

export const linkInfraPixelBm = defineOp({
  name: "linkInfraPixelBm",
  mode: "write",
  input: z.object({
    pixelId: z.string().min(1),
    bmId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkPixelBm(input),
});

// ── Pages

export const saveInfraPage = defineOp({
  name: "saveInfraPage",
  mode: "write",
  input: z.object({
    id: z.string().nullable().optional(),
    // The Facebook page id, optional even on an existing row: pages are tracked by URL first.
    pageId: z.string().nullable().optional(),
    pageUrl: z.string(),
    name: z.string(),
    ownerProfileId: z.string(),
    status: statusString,
    notes: nullableText,
  }),
  handler: (input) => savePage(input),
});

export const setInfraPageStatus = defineOp({
  name: "setInfraPageStatus",
  mode: "write",
  input: z.object({ id: z.string().min(1), status: statusString, reason: nullableText }),
  handler: (input) => setPageStatus(input),
});

export const verifyInfraPage = defineOp({
  name: "verifyInfraPage",
  mode: "write",
  input: idOnly,
  handler: (input) => verifyPage(input),
});

export const deleteInfraPage = defineOp({
  name: "deleteInfraPage",
  mode: "write",
  input: idOnly,
  handler: (input) => deletePage(input),
});

export const linkInfraPageBm = defineOp({
  name: "linkInfraPageBm",
  mode: "write",
  input: z.object({
    pageId: z.string().min(1),
    bmId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkPageBm(input),
});

export const linkInfraPageProfile = defineOp({
  name: "linkInfraPageProfile",
  mode: "write",
  input: z.object({
    pageId: z.string().min(1),
    profileId: z.string().min(1),
    action: linkAction,
  }),
  handler: (input) => linkPageProfile(input),
});
