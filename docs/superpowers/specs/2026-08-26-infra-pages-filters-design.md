# Pages: faceted filters and URL export — design

**Date:** 2026-08-26
**Status:** approved design
**Branch:** `feat/infra-pages-improvements`

## Problem

The Pages screen (`src/routes/infrastructure.pages.tsx`) offers one free-text search box and one
single-select status dropdown (`:242-254`). Two operator questions it cannot answer:

1. **"Show me the pages at risk under this BM."** Search is a single multi-hop `includes()` over a
   joined haystack (`:126-140`), so a BM name and a status cannot be combined, and no facet can hold
   two values — "restricted **or** banned" is unexpressible.
2. **"Give me the URLs of these twelve pages."** Copying is one row at a time via `CopyButton`
   (`:314`, `:553-571`). Handing a media buyer the pages for a launch means twelve clicks and a
   manual list.

Risk makes the first question worse: `pageRisk()` is called inline in the JSX cell (`:380-387`), so
the value exists only during render. It is neither filterable nor sortable, and the `bms` sort key
(`:149`) sorts by link count as a proxy.

## Decisions

| #   | Decision                                                                  | Rationale                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client-side only — no server fn, no URL search params                     | The loader (`:38-47`) already returns every page, BM and profile in one round trip. This is an operator registry at tens-of-rows scale; a server round trip per keystroke would be slower and would need pagination the screen doesn't have |
| 2   | Facets are **multi-select**: OR within a facet, AND across facets         | The whole point of decision 2 is "restricted or banned", which a `<select>` cannot express. Cross-facet AND is what makes "restricted pages under Main BM" one query                                                                        |
| 3   | Match rules and URL normalization live in a **pure module** with tests    | Follows `src/lib/infra-risk.ts` + `infra-risk.test.ts`. The repo has no component-test harness, so logic in a route file is untestable logic. The route keeps only state and markup                                                         |
| 4   | Risk is decorated onto each row **once**, before filtering                | Required for the facet and for an honest `Risk` sort key. Also deletes the inline JSX computation, so the badge and the filter can never disagree                                                                                           |
| 5   | Selection is a `Set<string>` of page ids that **survives filter changes** | Filter → select → refilter → select more is the reason multi-select exists. Pruning the set on every filter edit would silently drop what the operator just picked                                                                          |
| 6   | Exported URLs are normalized to `https://`, one per line                  | Same rule as the table's own anchor (`:293`): stored values are typed by hand and often lack a scheme. A list that isn't clickable when pasted is not the deliverable                                                                       |

## `FilterMenu`

New `src/components/infra/FilterMenu.tsx`, used five times.

| Prop       | Shape                                       |
| ---------- | ------------------------------------------- |
| `label`    | `string` — facet name on the trigger button |
| `options`  | `{ value, label, count }[]`                 |
| `selected` | `string[]`                                  |
| `onChange` | `(next: string[]) => void`                  |

Trigger is a `h-9` bordered button carrying the facet name plus a count badge when the facet is
active. The panel is a checkbox list with a per-option row count, a type-ahead input once
`options.length > 8`, and a `Clear` footer while anything is selected.

`PopoverContent` is portaled, for the reason already documented at `LinkChips.tsx:90-95`: these
controls sit above a table whose wrapper is `overflow-x-auto`, and an absolutely-positioned panel
gets clipped by that scroll box.

Selection is applied by **filtering the option vocabulary**, not by splicing the selected array — the
same technique as the profile status checkboxes (`infrastructure.profiles.tsx:379-384`) — so chips and
menu rows keep a stable order instead of reshuffling on each click.

## The five facets

Facet values are derived in `src/lib/infra-page-filters.ts`.

| Facet         | Options                                                                               | Match rule                                                    |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Status**    | All of `PAGE_STATUSES`, plus any unrecognized status present in the data              | `selected.includes(row.status)`                               |
| **Owner**     | Profiles owning ≥1 page; `— unknown owner —` when an `ownerProfileId` doesn't resolve | `selected.includes(row.ownerProfileId)`                       |
| **Linked BM** | BMs linked to ≥1 page, plus `— no BM access —`                                        | `row.bmIds` intersects selection; sentinel matches empty      |
| **Risk**      | `critical`, `warning`, `safe`                                                         | `selected.includes(row.risk.level)`                           |
| **Profiles**  | Profiles with added access on ≥1 page, plus `— owner only —`                          | `row.profileIds` intersects selection; sentinel matches empty |

**Fixed vocabularies list every value; entity facets list only what is present.** A `Status` menu
showing `banned · 0` is useful information. An `Owner` menu listing all 60 registered profiles when 9
own pages is noise, and picking one guarantees an empty table.

**Counts exclude the facet's own selection.** Each facet's counts are computed over the rows passing
the search box and every _other_ facet. Counting against the fully-filtered set would show `0` beside
every unselected value in an active facet, which reads as "no such pages" when it means "not with
your current pick in this same facet". Five extra passes over a few hundred rows.

Active values render as removable chips beneath the filter row with a `Clear all`. The existing search
box and its multi-hop haystack are unchanged and AND with the facets.

## Selection and URL export

- Leading checkbox column. The header checkbox is checked when every currently-filtered row is
  selected, indeterminate when some are, and toggles exactly the filtered rows — never hidden ones.
- A `fixed bottom-6` bar appears while the selection is non-empty: `N selected`, `Copy URLs`,
  `View URLs`, `Clear`. Floating rather than in the card footer, which sits below the fold on a long
  table — and `fixed` rather than `sticky` because the layout's scroll ancestor
  (`<main class="flex-1 overflow-x-hidden">`) computes `overflow-y: auto` while growing with its
  content: it is the sticky scrollport but never scrolls, so a sticky bar resolves to its flow
  position. Measured before the fix: bar top at 5862px in a 950px viewport.
- `View URLs` opens a dialog: read-only `textarea`, one normalized URL per line, plus its own copy
  button. The textarea exists so the list can be eyeballed and partially selected, not only
  clipboarded.
- **Pages with a blank `pageUrl` are excluded** from the output and reported as
  `k selected pages have no URL` in both the bar and the dialog. `pageUrl` is `NOT NULL` and required
  by the form (`:466`), but empty strings exist in older rows — the table already branches on
  `r.pageUrl ? … : r.pageId` (`:302-325`). With no URLs at all in the selection, both copy paths are
  disabled.
- Selection survives filter edits (decision 5) and is dropped on `router.invalidate()` only for ids
  that no longer exist, so a delete cannot leave a phantom in the count.
- **A rejected clipboard write opens the dialog** instead of failing silently. `navigator.clipboard`
  refuses without permission or a secure context, and `void copyUrls()` would otherwise swallow the
  rejection, leaving the operator to paste whatever was in the clipboard before.

## Two fixes this work required

- **`useSort` crashed when sorting an empty table.** `toggle()` sampled `accessors[k]?.(rows[0])` to
  pick an initial direction; with no rows, `rows[0]` is `undefined` and any accessor reading a field
  threw. Latent across every registry screen, but five facets make an empty result set routine, so it
  is guarded in `SortableTable.tsx` rather than worked around here.
- **The per-row copy button now yields the normalized URL**, matching the export. It previously
  copied the raw stored value, so the same page copied one way was clickable and the other way was
  not.

## Out of scope

Server-side filtering, filter state in the URL (no shareable-link requirement was raised), saved
filter presets, CSV export of anything beyond URLs, and applying the same facets to the Pixels / BMs /
Ad Accounts screens. The `FilterMenu` component is written to be reusable there, but wiring it is a
separate change.

## Verification

- Unit tests for `src/lib/infra-page-filters.ts`: OR within a facet and AND across facets, both
  sentinel options (`no BM access`, `owner only`), unknown-status and unresolved-owner option
  derivation, the other-facets-only count rule, `https://` normalization of a scheme-less value, and
  blank-URL exclusion from the export.
- `bunx tsc --noEmit` and `bun run lint` clean.
- Browser smoke test on `bun run dev`: each facet applied alone, two facets combined, select-all under
  an active filter, `Copy URLs` clipboard content, and the dialog's line list.
