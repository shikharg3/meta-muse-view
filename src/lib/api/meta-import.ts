import { createServerFn } from "@tanstack/react-start";
import {
  commitMetaImport,
  deleteImportedAccount as deleteImportedAccountImpl,
  fetchImportPage,
  previewMetaImport,
} from "@/server/fns/meta-import";
import type { ImportOptions } from "@/server/meta-import";

/** Every fn here is refused unless the request Host is in IMPORT_HOSTS and the caller is an admin. */
export const getImportPage = createServerFn({ method: "GET" }).handler(() => fetchImportPage());

export const previewImport = createServerFn({ method: "POST" })
  .inputValidator((d: ImportOptions) => d)
  .handler(({ data }) => previewMetaImport(data));

export const commitImport = createServerFn({ method: "POST" })
  .inputValidator((d: ImportOptions) => d)
  .handler(({ data }) => commitMetaImport(data));

export const deleteImportedAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { accountId: string }) => d)
  .handler(({ data }) => deleteImportedAccountImpl(data.accountId));
