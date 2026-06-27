---
name: Job visits & technician person link
description: How site visits (výjezdy) link to a job and how a logged-in user maps to a technician.
---

# Job visits (výjezdy)

`job_visits` are per-job technician site visits (date/personId/note/status planned|done), separate from the job's single `assignedPersonId` field and from time tracking/billing.

## User → person link for /me/visits
There is **no FK linking a user account to a person row**. The only available link is `users.name === people.name`. `/me/visits` resolves the technician by name match (can match multiple person rows → use `inArray`), then returns planned visits joined to jobs.

**Why:** the schema never modeled a user↔person relationship; name is the sole bridge.

**How to apply:** any "my X" feature that must scope by the logged-in technician must match `people.name` to `req.auth.name`, and handle 0 or >1 matches.

## Invalidation
Visit write paths live under `/api/jobs/:id/visits`, so the server live-updates `domainsForPath` already maps them to the `jobs` domain. On the client, `/api/me/visits` was added to the `jobs` domain prefix list so a visit mutation refreshes the technician's overview.
