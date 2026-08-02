# Checkpoint FÁZE 13.3 – nezávislé review a staging authorization gate

- **Datum:** 2026-08-02.
- **Stav práce fáze:** **COMPLETE** pro nezávislé security/migration review.
- **Release verdikt:** **REQUESTED CHANGES; staging authorization BLOCKED**.
- **Reviewovaný head:** `12d57c512550a1a273947cbc742f577faddc5f72`.
- **Remote `main`:** beze změny na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Produkce/remote:** bez merge, deploye, workflow dispatch a produkčních zápisů.
- **Migrace 0100:** nebyla zařazena, čtena z PR ani změněna.

## Uložené výstupy

- [centrální security a migration review](13-3-security-migration-review.md)
- [fail-closed staging authorization gate](13-3-staging-authorization-gate.md)
- [PR #1](https://github.com/modvolt/Site-Logbook/pull/1)
- [zelený remote quality gate na původním headu](https://github.com/modvolt/Site-Logbook/actions/runs/30754695026)

## Shrnutí výsledku

Review potvrdilo dva Medium code/release blockery:

1. guest může přes authenticated-only `/storage/uploads` zapisovat staged objekty;
2. CI ověřuje migrace na PostgreSQL 18, ale cílový deklarovaný stack je 16.

Další Medium rollout podmínkou je řízený cutover historických PPE bearer tokenů,
které migrace 0101 ponechá použitelné 30 dní od migrace. Low nález se týká
interních DB/storage detailů v neočekávaných chybových odpovědích a logování
access-key identifikátoru.

Pozitivně byly potvrzeny session rotation/generation, odstraněný question recovery,
vault step-up, default-deny route policy, private-object authorization, owner-bound
upload claim, hash-only one-time tokeny a immutable job/quote evidence. Tyto PASS
body nezneplatňují blockery a nejsou externím staging důkazem.

Migrační sada 0096–0099 a 0101–0102 je párovaná s rollbacky, journal nemá duplicity
a vlastní migrátor umí out-of-order recovery a parity fail. Mezera 0100 je v tomto
PR přijatelná pouze proto, že 0100 zůstává úplně mimo kandidáta. Její případné
pozdější vydání vyžaduje samostatný nový pořadový krok a nový upgrade důkaz.

## Provedené kontroly

| Kontrola                            | Výsledek                                                 |
| ----------------------------------- | -------------------------------------------------------- |
| GitHub PR metadata                  | PASS; draft, open, mergeable, head `12d57c5`, 43 commitů |
| Remote `main` přes GitHub connector | PASS; latest `a25c312`                                   |
| Remote quality run pro head         | PASS; run `30754695026`, `completed/success`             |
| Submitted reviews / review threads  | BLOCKED; 0 / 0                                           |
| Přesný PR diff                      | PASS; `git diff --check`                                 |
| Migrace/rollback páry               | PASS; 6/6 forward, 6/6 rollback, 6/6 snapshot            |
| Přítomnost 0100 v PR                | PASS; absent                                             |
| Journal integrita                   | PASS; 102 entries, 0 duplicate idx, 0 duplicate when     |
| Cílový PostgreSQL major v CI        | FAIL; CI 18, provozní deklarace 16                       |
| Guest upload write boundary         | FAIL; authenticated-only bez write permission            |
| GitHub Environment/staging handly   | BLOCKED; nebyly nezávisle doloženy                       |
| Produkční testy nebo zápisy         | NOT RUN; zakázané a nepotřebné pro toto review           |

Čistý detached worktree přesného PR headu byl použit jen pro čtení a statické
kontroly. Nebyly instalovány dependency, spuštěny síťové staging testy ani použity
secret hodnoty. Relevantní plný remote gate byl již zelený na přesném headu;
review nezveličuje tento důkaz na PostgreSQL 16 nebo skutečný staging.

## Nejasnosti a chybějící autorita

- Které konkrétní write oprávnění má chránit sdílený upload pro job, activity,
  customer, billing a switchboard workflow.
- Jaké maximální stáří legacy PPE tokenu service owner přijme při cutoveru.
- Kdo je nezávislý reviewer a kdo vlastní staging, RPO/RTO, rollback a cleanup.
- Zda GitHub Environment `staging` existuje se správnou protection policy;
  konektor tuto metadata hranici nepokrývá a lokální `gh` token byl při kontrole
  neplatný.
- Jaké jsou redigované fingerprinty izolované DB/storage/mail infrastruktury.

## Jednoznačný checkpoint

FÁZE 13.3 zde končí. Nezávislé review je dokončeno a uloženo, ale kandidát dostává
stav **REQUESTED CHANGES** a staging gate zůstává **BLOCKED**. Nebyl proveden žádný
merge, deploy, workflow dispatch, produkční přístup ani změna migrace 0100.

Automaticky se nepokračuje. Úzké opravy mohou začít pouze po novém výslovném
pokynu uživatele. Samotné dokončení oprav neautorizuje staging ani produkci.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.4 – schválené úzké odstranění blockerů F13.3-01 a
  F13.3-02, hardening chybových odpovědí a doplnění rollout preflightu pro legacy
  PPE tokeny; následné nezávislé re-review, bez automatického stagingu nebo merge;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** oprava zasahuje společnou upload autorizační
  hranici používanou více moduly, cílový migrační CI kontrakt a veřejné bearer
  tokeny; je nutné zachovat field workflow, fail-closed role a kompatibilitu
  historických dat bez rozšíření oprávnění;
- **očekávané činnosti:** navrhnout a po explicitním schválení implementovat
  nejmenší write guard pro upload, přidat guest/role kontrakty, srovnat CI s
  PostgreSQL 16, genericky redigovat neočekávané veřejné/storage chyby, doplnit
  secret-free legacy-token preflight, spustit cílené testy a celý remote gate na
  novém přesném SHA a vrátit změny k nezávislému review;
- **soubory, které budou pravděpodobně změněny:** `.github/workflows/quality-gate.yml`,
  `artifacts/api-server/src/lib/api-route-access-policy.ts`,
  `artifacts/api-server/src/routes/storage.ts`, `artifacts/api-server/src/routes/quotes.ts`,
  související API contract/security testy, případně nový read-only preflight script
  a `docs/audit/13-4-*`; migrace 0100 zůstane mimo rozsah;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** vlastní dva
  blockery novou migraci nepotřebují, ale autorizace a veřejné tokeny jsou vysoce
  rizikové. Testy migrací 0096–0102 smějí běžet jen na izolované PostgreSQL 16 DB.
  Žádná produkční migrace, staging dispatch, merge ani deploy není ve FÁZI 13.4
  automaticky povolen; migrace 0100 zůstává výslovně vyloučena.
