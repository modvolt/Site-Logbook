# R09-D – canonical audit DB expand a transaction adapter

Datum: 2026-08-12

Base: `5f833ecbc26b151ed4cb02fab5d1a0b21bca60c2`

Větev: `agent/r09-audit-control-plane`

Stav: **lokálně implementováno a cíleně ověřeno; default-dark, bez callerů; R09 jako celek zůstává NOT READY**

## Uzavřený řez

- `AuditChainTransactionV1` zapisuje canonical event a ledger jednou atomickou operací `insertEventAndLedger`.
- Caller-owned Drizzle adapter nemá vlastní commit, rollback ani transaction factory a před zápisem vždy volá aplikační `verifyAuditEventEnvelope`, `verifyAuditChainRecord` a `verifyAuditExportIntent`.
- Expand-only Drizzle schema přidává `audit_events`, singleton `audit_chain_heads` a durable `audit_export_outbox`.
- Generated migration identity je `0107_canonical_audit_evidence`, journal timestamp `1786484628859`, SHA-256 `5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339`. `0100` zůstává nepřítomná.
- DB trigger před event insertem zamyká head, vyžaduje přesného následníka a kontroluje canonical bytes, exact top-level/nested keys, safe-integer CJSON, domain-separated event/ledger hash a základní actor/source/action/projection semantics.
- Event i ledger hash mají vlastní unique index. Event řádek je immutable a deferred commit trigger vyžaduje odpovídající outbox intent i posunutý durable head.
- Outbox přechody jsou fail-closed; `exporting -> exporting` lease renewal je explicitně zakázaný, dokud nevznikne samostatný renewal kontrakt.
- Rollback nejprve získá migration advisory lock `911072468`, poté deterministické `ACCESS EXCLUSIVE` locky. Povolí odstranění pouze jediného nepoužitého genesis schema a přesného jediného journal row podle timestampu i hashe.

## Ověření

- `pnpm run typecheck:libs`: PASS.
- API `tsc -p tsconfig.json --noEmit`: PASS.
- Cílené statické a unit kontrakty: `9/9 PASS` ve 2 souborech.
- PostgreSQL 16 pinned image: migrace `107/107 PASS`.
- Izolované DB kontrakty: expand/adapter/trigger/concurrency `7/7 PASS`; empty rollback `1/1 PASS`.
- CJSON parity fixtures pokrývají C/ASCII pořadí klíčů, české Unicode, quote/backslash/control escapování, arrays, null/bool, safe-int minima/maxima a odmítnutí decimal/exponent/noncanonical/unsafe integer vstupů.
- Raw SQL negativní testy pokrývají `{}`, chybějící a extra klíče, necanonical whitespace/order, actor/source/action/projection core mutations a null export receipt.
- Concurrency test prokazuje, že rollback čeká na in-flight writer; po jeho commitu guard rollback odmítne a evidence zůstane.
- Docker běžel pouze na random loopback portu s limity 1 CPU, 1536 MiB a 256 PID; kontejner byl odstraněn ve `finally`.
- `git diff --check`: PASS; zbývají pouze Windows LF/CRLF checkout warningy.

## Neuzavřené hranice

- Neexistuje žádný aktivovaný caller, dual-write, export worker, offline verifier ani runtime 0106→0107 control plane.
- SQL validátor dorovnává canonical bytes, domain hashes a klíčové core semantics, ale zatím není úplnou kopií všech Zod policy pravidel pro reason/artifact registry a všechny provenance kombinace.
- `REVOKE ... FROM PUBLIC` není oddělení runtime app role od DB ownera. Full role/privilege boundary, ochrana proti owner-level `TRUNCATE` a plná direct-SQL semantic parity jsou P1 před aktivací.
- Chybí query projections/indexy pro actor/entity/action; jde o P2 před širším provozním využitím.
- Nebyl proveden commit, push, deploy ani spuštění migrace proti sdílené, staging nebo produkční databázi.

## Checkpoint

Tento řez je připraven pouze jako additive default-dark schema/adapter kandidát s nulou callsites. Nesmí být označen za připravený pro pilot, export, staging cutover ani produkci. Další bezpečný celek musí nejprve uzavřít plnou aplikační/SQL policy parity a runtime role separation; až poté lze samostatně aktivovat první caller a exporter s vlastními schváleními.
