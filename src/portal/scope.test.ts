import { describe, expect, it } from "bun:test";
import { runAsPortalActor } from "@/portal/context";
import { agencyBrandScope, type PortalActor } from "@/portal/scope";

/**
 * `agencyBrandScope()` resolves brands as a LOOKUP with no grant layer — it is how the agency's own
 * screens see a client's report. It lives in the module every `portal*` op already imports for
 * `portalScope` and `narrowToBrands`, so the realistic failure is not someone deciding to misuse
 * it: it is a future portal op reaching for the wrong autocomplete suggestion and quietly returning
 * every brand the agency has to one customer.
 *
 * This pins the structural refusal rather than the comment that asks for it. No database is
 * touched: the guard throws before the first query, which is also what makes the test meaningful —
 * if it ever stopped throwing, this would fail on a connection error rather than pass silently.
 */
describe("agencyBrandScope", () => {
  const actor: PortalActor = {
    id: "portal-user-1",
    email: "client@example.com",
    name: "Client",
    status: "approved",
  };

  it("refuses to run on the portal transport", async () => {
    await runAsPortalActor(actor, async () => {
      await expect(agencyBrandScope(actor, ["brand-1"])).rejects.toThrow(/admin-only/);
    });
  });

  it("refuses even when no brands were requested, which would otherwise mean every brand", async () => {
    await runAsPortalActor(actor, async () => {
      await expect(agencyBrandScope(actor, undefined)).rejects.toThrow(/portal transport/);
    });
  });
});
