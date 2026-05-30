---
name: Time-entry timer accumulation
description: How per-person time_entries timers accumulate hours and the rule that prevents double-counting on manual edits.
---

# Per-person time tracking (time_entries)

Each `time_entries` row is one person per parent (UNIQUE(person_id, job_id) and UNIQUE(person_id, activity_id)). `hours` is the accumulated base; `timer_started_at` non-null means a live session is running.

- **start**: upsert with `timerStartedAt = coalesce(existing, now())` — idempotent, never resets a running session.
- **stop**: `hours += extract(epoch from now() - timerStartedAt)/3600`, then clear `timerStartedAt`. Row-level locking makes concurrent stops safe (second update sees null).

**Rule:** any write that sets `hours` while a timer may be running MUST rebase the timer in the same atomic UPDATE (`timerStartedAt = case when not null then now() else it end`), otherwise the next stop adds the full in-flight session on top of the new manual value → inflated totals.

**Why:** manual hour entry (`PATCH setHours`) and the live timer share one `hours` column; without rebasing, edit-while-running double-counts.

**How to apply:** kept the manual-edit UI hidden while running as a first guard, but the backend rebase is the real safety net — don't drop it if the UI changes.
