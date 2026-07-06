---
name: Workflow name mismatch on restart_workflow
description: restart_workflow can fail RUN_COMMAND_NOT_FOUND even though the artifact is registered and was working before.
---

# Workflow name mismatch on restart_workflow

If `restart_workflow` fails with `RUN_COMMAND_NOT_FOUND` for a workflow name
taken from an artifact's `.replit-artifact/artifact.toml` `title` or
`[[services]] name`, don't assume the artifact needs re-registering.

The actual registered workflow name in `.replit` is often prefixed differently,
e.g. `artifacts/api-server: API Server` or `artifacts/stavba: web`, not the bare
`title`/service `name` from the toml. Call `refresh_all_logs` first — it lists
every configured workflow by its real name (including `NOT_STARTED` ones) — and
retry `restart_workflow` with the exact name shown there before creating a new
workflow via `configureWorkflow`. Creating a duplicate with the guessed name
will fail anyway (missing `PORT`/`BASE_PATH` env wiring that only the real
artifact-bound workflow has) and leaves a stray broken entry in `.replit` that
must be cleaned up with `removeWorkflow`.
