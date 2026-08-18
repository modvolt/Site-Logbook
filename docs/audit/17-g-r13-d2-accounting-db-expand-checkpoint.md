# R13-D2 – accounting DB expand checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako expand-only implementace; R13 jako celek NOT READY**

## Výsledek

R13-D2 převádí dřívější canonical a transakční kontrakt do konkrétní, ale zatím nenasazené DB vrstvy:

- `AccountingAggregateStateV1` obsahuje monotónní decimal `revision`; každá atomická operace mění každý dotčený aggregate právě o `revision + 1`, včetně same-root correction bundle;
- šest additive Drizzle tabulek ukládá immutable document versions, lifecycle/payment eventy, version relations, export outbox a aggregate heads;
- konkrétní adapter pracuje pouze nad již otevřenou caller transaction, zamyká původní invoice nebo billing-document root a head, ukládá exact canonical bytes a provádí full-state compare-and-advance;
- nečíslovaná SQL šablona obsahuje restrictive FK, canonical-envelope identity CHECKy, insert binding, append-only evidence triggery, immutable intent fields a exact successor head trigger;
- přímý DB writer nemůže rozdělit denormalizované ID/sekvenci/digest od identity v `canonical_json`; kryptografický přepočet aplikačního CJSON zůstává v strict adapteru/verifieru, nikoli předstíraně v PostgreSQL.

## Bezpečnostní hranice

- SQL je pouze `docs/audit/17-f-r13-accounting-evidence-expand.template.sql`; v `lib/db/migrations` nevznikl žádný nový soubor a journal zůstává 105/105 s tail `0105_smooth_nitro`;
- pozdější R13-D9B tuto stejnou nečíslovanou šablonu additive rozšířil o warehouse-price observation persistence; D2 historický rozsah šesti původních tabulek se tím zpětně nemění;
- šablona nebyla aplikována na staging ani produkci; běžela pouze v disposable lokální PostgreSQL databázi;
- nebyl proveden backfill, route/service cutover, export do S3, push, workflow dispatch ani deploy;
- číslo nové migrace nelze přidělit před integrací veřejného main a vyřešením kolize dvou různých `0096`; `0100` zůstává výslovně vyloučena.

## Ověření

- R13-D0–D2 cílené unit/contract testy: **39/39 PASS**;
- disposable PostgreSQL 16 SQL + adapter mutation sada: **5/5 PASS** nad standardními migracemi **105/105**, latest `0105_smooth_nitro`;
- celý API unit/contract: **93 souborů, 726/726 PASS**;
- DB a API TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaných Windows LF→CRLF upozornění;
- Docker test měl limit 1 CPU / 1 GiB a po běhu zůstalo **0** kontejnerů.

## Co zbývá v R13

1. Po schválené integraci veřejného main vytvořit z auditované šablony skutečnou expand migraci s novým nekolidujícím číslem.
2. Přidat dual-write/cutover po jednom terminálním seamu; první řez nesmí kombinovat všech šest cest.
3. Vytvořit dry-run legacy inventory a samostatný idempotentní backfill `legacy_observation` bez falešné historie.
4. Implementovat lease-based archive worker, canonical bundle/manifest/checksum a offline verifier nad versioned Hetzner S3.
5. Doplnit kill/fault testy pro rollback mezi domain write, evidence insert, head CAS a export intentem; teprve potom aktivovat DB privilege/route cutover.

## Doporučený další řez

R13-D3 má být bez migrace: navrhnout a otestovat export worker/verifier nad fake transaction/object-storage portem a přesně zvolit první terminální dual-write seam. Číslovaná migrace a její spuštění zůstávají samostatnou pozdější approval boundary.
