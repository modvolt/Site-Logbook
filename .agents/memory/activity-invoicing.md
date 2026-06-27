---
name: Activity (dlouhodobé akce) invoicing
description: How completed long-term actions become invoiceable alongside jobs in Fakturace.
---

Completed activities (completedAt set, not archived) with material and/or extra-work appear in
"Nevyfakturované zakázky" next to jobs and can be invoiced.

- **Billed = source link, not status.** An activity is "billed" iff referenced by an
  `invoice_source_links` row on a non-cancelled invoice. `activities.billingStatus` is cosmetic.
  **Why:** unlike jobs (protected by their done→vyfakturovano status transition), activities have
  no status guard, so the link is the ONLY thing preventing double-billing. **How to apply:** any
  new path that bills/offers an activity must check the link, never billingStatus.

- **Double-bill is guarded at TWO points** because billingStatus can't help: draft-build rejects an
  activity already linked to a non-cancelled invoice (400), and issue-time re-checks under the
  activity row lock excluding the current invoice (409, before any PDF/number work). The issue-time
  check is the required guard (covers the stale-draft race where a 2nd draft was built first).

- **No per-material reservation for activities.** Jobs reserve billed materials individually;
  activities rely solely on the activity-level source link.

- **Distinct sourceTypes** `activity_work` (per extra-work, amount>0) and `activity_material`
  (per priced material, with markup), deliberately NOT "material"/"job" so they don't collide with
  the job-material reservation filter or job source-link grouping. Both are in the OpenAPI
  sourceType enums so manual-edit round-trip validates.

- **Orientational total** = extraWorks(amount) + materials(qty*pricePerUnit, with markup).
  Activities have NO price/transport/parking/fines.

- **Markup overrides MUST be namespaced by sourceType ("material" vs "activity_material").**
  Job materials and activity materials are separate tables with independent id sequences, so a bare
  numeric materialId collides across them. **Why:** an override keyed by bare id silently applied a
  job's markup to an activity line (and vice versa) → wrong invoice totals. **How to apply:**
  createDraft splits `materialMarkupOverrides` into two maps by `sourceType` (omitted = "material",
  back-compat) and feeds each to its own line builder; the frontend keys its markup state by
  `${sourceType}:${id}` and stamps `sourceType` onto every override it sends. The category resolver
  is still shared (keyed by item name, no collision).
