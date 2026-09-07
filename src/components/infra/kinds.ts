import { Building2, CreditCard, Flag, IdCard, Target, type LucideIcon } from "lucide-react";
import type { InfraNodeKind } from "@/lib/infra-graph";

/**
 * One home for how each entity kind is named, iconed and linked, so the matrix rows, the finding
 * chips and the filtered-list heading cannot drift apart.
 *
 * `label` is the plural column name; `short` is the singular chip that sits beside an entity's own
 * name, where "Business Managers" would be noise next to "DOT Media 04".
 */
export const KIND_META: Record<
  InfraNodeKind,
  {
    label: string;
    short: string;
    icon: LucideIcon;
    to: string;
    /**
     * Statuses a row is expected to be in. A finding only prints its status when it is NOT one of
     * these — the four status vocabularies disagree on the word for "fine" (`active`, `in_use`,
     * `published`), and printing it on every row was one of the encodings that made the old table
     * unreadable.
     */
    normal: readonly string[];
  }
> = {
  bm: {
    label: "Business Managers",
    short: "BM",
    icon: Building2,
    to: "/infrastructure/business-managers",
    normal: ["active"],
  },
  adAccount: {
    label: "Ad Accounts",
    short: "Ad account",
    icon: CreditCard,
    to: "/infrastructure/ad-accounts",
    normal: ["in_use", "spare"],
  },
  pixel: {
    label: "Pixels",
    short: "Pixel",
    icon: Target,
    to: "/infrastructure/pixels",
    normal: ["active"],
  },
  page: {
    label: "Pages",
    short: "Page",
    icon: Flag,
    to: "/infrastructure/pages",
    normal: ["published"],
  },
  profile: {
    label: "Profiles",
    short: "Profile",
    icon: IdCard,
    to: "/infrastructure/profiles",
    normal: ["active"],
  },
};
