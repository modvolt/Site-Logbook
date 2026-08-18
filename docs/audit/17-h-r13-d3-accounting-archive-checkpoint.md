# R13-D3 – účetní archiv, worker a offline verifier

Datum: 2026-08-11  
Stav: **lokálně READY jako neaktivovaný archivní řez; R13 jako celek NOT READY**

## Výsledek

R13-D3 uzavírá lokální cestu od atomického export intentu z D2 po nezávisle ověřitelný archiv, stále bez připojení k produkčnímu nebo staging S3:

- strict `site-logbook.accounting-archive-bundle/v1` obsahuje exact canonical export intent a právě jeho deklarované document/lifecycle/payment/relation evidence;
- `bundle.sha256` používá přesný GNU sidecar formát a `site-logbook.accounting-archive-manifest/v1` váže intent, ordered entry set, bundle/checksum bytes, media type, velikost a provider `VersionId` obou objektů;
- manifest se zapisuje poslední a funguje jako commit marker; content-addressed cesta je `accounting-evidence/v1/<intent-id>/<intent-sha256>/...`, takže žádný mutable `latest` pointer není součástí důkazní hranice;
- offline verifier znovu canonicalizuje a kryptograficky ověří intent i každý embedded evidence envelope, všechny tři raw soubory, exact object keys, velikosti a odděleně schválený outbox receipt;
- lease worker zapisuje bundle → checksum → manifest, čte zpět přesné provider verze a teprve poté CAS přepne outbox na `exported`; partial write, restart nebo ztracený lease zůstávají idempotentní a nesmějí vytvořit novou verzi stejného objektu;
- PostgreSQL adapter používá `FOR UPDATE SKIP LOCKED`, obnovitelný lease, bounded exponential retry, dead-letter a compare-and-set podle `intent_id + state + lease_token`; expired worker už nesmí potvrdit export;
- export receipt v outboxu nově trvale váže manifest key/version a SHA-256 manifestu, bundle i checksumu. Terminální `exported`/`dead_letter` row je DB triggerem immutable;
- CLI `pnpm --filter @workspace/api-server accounting:archive:verify` vyžaduje tři oddělené absolutní regular-file cesty, všechny schválené receipt hodnoty a zvlášť pozorovaný manifest `VersionId` z exact-version downloadu; symlink, změna velikosti během čtení, jiný observed/expected `VersionId`, chybějící digest nebo jiný intent failují.

## Resource a failure hranice

- canonical evidence entry má hard limit 32 MiB a celý bundle 64 MiB; checksum má 256 B a manifest 256 KiB;
- worker dělá bounded read-back sekvenčně, nikoli třemi souběžnými velkými buffery;
- překročení limitu je explicitní `invalid_evidence` dead-letter/repair případ. Limit se nesmí tiše zvýšit bez streaming canonicalizeru a nového resource testu;
- retryable provider chyba se opakuje nejvýše osmkrát, permanentní evidence/receipt/tamper chyba jde rovnou do dead-letter;
- storage port vyžaduje create-only nebo exact-existing chování, versioned read podle konkrétního `VersionId` a read-back. Běžné `ObjectStorageService.putPrivateObject`, které `VersionId` zahazuje, tento kontrakt záměrně nesplňuje.
- raw JSON neumí sám kryptograficky dokázat provider `VersionId`; online worker jej váže exact-version readem a offline CLI vyžaduje oddělit observed ID z downloadu od expected ID z outbox receipt. Bez provider download evidence smí offline výsledek tvrdit integritu obsahu, ne původ konkrétní S3 verze.

## Bezpečnostní hranice

- nebyl vytvořen ani spuštěn konkrétní Hetzner S3 adapter, žádný bucket/object/version ani secret nebyl čten nebo změněn;
- worker není zapojen do API startupu, scheduleru ani route a nemůže se sám spustit;
- refined tabulka a triggery jsou stále pouze v nečíslované šabloně `17-f-r13-accounting-evidence-expand.template.sql`; `lib/db/migrations` zůstává 105/105, tail `0105_smooth_nitro`, bez `0100`;
- nebyl proveden backfill, route/service dual-write, push, workflow dispatch, deploy ani staging/produkční migrace;
- skutečné migrační číslo nelze přidělit před schválenou integrací veřejného `main` a forward-only vyřešením kolize dvou různých `0096`.

## Ověření

- archive contract/worker, skutečné offline CLI a expand static kontrakt: **14/14 PASS**;
- disposable PostgreSQL 16 lease/CAS/trigger sada: **7/7 PASS** nad standardními migracemi **105/105**, latest `0105_smooth_nitro`;
- partial upload, exact-version retry, lost lease, chybějící evidence, read-back tamper, vyčerpaný retry budget, checksum tamper, entry mismatch a receipt mismatch mají negativní test;
- celý API unit/contract gate: **94 souborů, 737/737 PASS**;
- API a DB TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaných Windows LF→CRLF upozornění;
- disposable Docker měl limit 1 CPU / 1 GiB a po testu byl odstraněn.

## Co zbývá v R13

1. Integrovat veřejný `main` a vyřešit 0096 lineage; teprve potom vytvořit skutečnou expand migraci, stále bez `0100`.
2. Doložit read-only capability preflight budoucího Hetzner bucketu: versioning, create-only conditional write, exact `VersionId` read, retention/object-lock policy a samostatný staging namespace. Teprve poté lze implementovat storage adapter.
3. Vybrat první jediný terminální dual-write seam, doporučeně issue invoice, a fault-testovat rollback mezi domain write, canonical evidence, head CAS a export intentem.
4. Doplnit scheduler/metrics/dead-letter operator surface až po nasazení expand tabulek; startup worker nesmí předcházet migraci a provider preflightu.
5. Připravit dry-run legacy inventory a samostatný idempotentní backfill `legacy_observation` bez domyšlených eventů, actorů nebo časů.

## Doporučený další řez

R13-D4 má zůstat bez externí mutace: zapojit právě jeden `issueInvoice` seam do caller-owned evidence transakce přes feature-flagged dual-write, přidat kill/fault testy a characterization parity. Skutečná migrace, S3 zápis a runtime aktivace zůstávají samostatné approval boundaries.
