# R13-D9H/D9I – restricted reason artifact a explicitní disposition checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark expand/caller vrstva; bez číslované migrace, UI cutoveru, provider aktivace, deploye a produkčního zápisu; R13 jako celek NOT READY**

## Výsledek

Schválené volby 1A a 2A jsou implementované jako dvě technicky odlišné cesty:

- `early_discard` je povolen jen pro nedotčený stav `uploaded`, vyžaduje explicitní operational reason code a potvrzení a nevytváří accounting version, event, head ani export intent;
- `reviewed_rejection` je povolen jen pro otevřený review stav s alespoň jedním source artifactem a atomicky vytváří native version `discarded_observation`, sequence-zero event `ignored`, aggregate head, běžný initial-version export intent, restricted reason artifact a jeho vlastní restricted export intent.

Obě cesty předem odmítají existující accounting head, warehouse-price history a již fakturované řádky. Early discard navíc odmítne jakýkoli review/extraction, document-type decision, doménový link, merge decision, line nebo reference. Stav `ignored` proto už sám není bezpečnostní důkaz; rozhoduje ověřená disposition policy.

## Restricted čitelný důvod

Canonical `site-logbook.accounting-reason-artifact/v1` obsahuje allowlisted reason code, NFC-normalizovaný a ořezaný text 3–1000 znaků, domain-separated text digest, exact lifecycle-event binding, retention metadata a access policy:

- `mode=restricted`;
- `listing=metadata-only`;
- `plaintextExport=authorized-audit-only`;
- `legalHoldAware=true`;
- `selectivePlaintextRewriteSupported=false`.

Kontrola odmítá control znaky a známé secret formáty. Čitelný text není v lifecycle eventu, obecném `audit_log.summary`, běžném archive namespace ani object key. Event nese pouze reason code a digest. Reason outbox používá exact namespace `accounting-evidence-restricted/v1`; archive bundle, checksum i manifest jsou v tomto odděleném prefixu a offline verifier znovu ověří canonical bytes, digest i vazbu na event.

Stejný reason-artifact kontrakt je zapojen také do D8 `review_reopened`, takže čitelný důvod opravy už není jen lokální UI text bez archivní vazby.

## Atomická DB hranice

Additive Drizzle model a nečíslovaná SQL šablona přidávají `accounting_reason_artifacts` s restrictive FK na dokument, version a lifecycle event, unique event bindingem, strict canonical column bindingem a immutable update/delete triggerem. Insert trigger znovu ověřuje document/version/event/reason/digest vazbu.

`disposeCostDocument` zamkne source row, znovu načte klasifikační fakta a reviewed rejection uloží ve stejné caller-owned transakci jako mutable status projection a minimalizovaný audit code. Selhání restricted outbox insertu rollbackne version, event, reason artifact, oba export intents, aggregate head, audit i status.

Přímý legacy přechod přes `setDocumentStatus(..., "ignored")` je po exact aktivaci rejection flagu odmítnut. Default-dark `ACCOUNTING_COST_DOCUMENT_REJECTION_DUAL_WRITE_ENABLED=true` vyžaduje současně aktivní approval persistence plane; bez číslované migrace se nesmí zapnout.

## API hranice

Nový endpoint `POST /billing/documents/{id}/disposition` má strict discriminated input:

- `early_discard`: `reasonCode=invalid_upload|not_a_document`, `confirmed=true`, bez free textu;
- `reviewed_rejection`: `reasonCode=duplicate_document|invalid_document`, povinný bounded `reason`.

OpenAPI a generované React/Zod klienty byly regenerované. Současné UI ještě používá legacy status endpoint; UI přepnutí musí proběhnout až společně s číslovanou expand migrací, aktivací flagů a rollback plánem, jinak by default-dark reviewed cesta správně skončila `503`.

## Ověření

- reason/disposition/archive/audit-redaction/write-seam focused unit slice: **10 souborů, 74/74 PASS**;
- celý hermetický API unit/contract gate: **106/106 souborů, 792/792 PASS**;
- isolated PostgreSQL 16 correction + disposition seam: **2/2 soubory, 9/9 PASS**, template nejprve aplikovala **105/105** migrací, latest `0105_smooth_nitro`;
- DB test prokázal nulovou accounting evidence u early discardu, exact version/event/reason/two-intent/head u reviewed rejection, absenci čitelného důvodu v běžných artefaktech a auditu, hard-delete containment a úplný rollback při odmítnutí právě `reason-artifact` outbox insertu;
- OpenAPI codegen, DB/API TypeScript a cílený Prettier: **PASS**.

## Nezměněné hranice

- nevznikla číslovaná migrace a `0100` zůstává vyloučena;
- nebyl změněn env, runtime flag, frontend action, provider, S3, staging ani produkce;
- neproběhl backfill, deploy, commit ani push;
- early operational audit stále čeká na obecný R09 durable audit a R10 retention/case implementaci;
- archive provider/worker runtime zůstává neaktivovaný;
- warehouse-price approval/correction caller, controlled bootstrap/backfill a read cutover zůstávají samostatnou částí D9/R13.

## Další bezpečný řez

Nejbližší čistě lokální krok je připojit už hotový warehouse-price observation + projection seam do approval/correction callerů za samostatný exact default-dark flag a přidat transakční DB fault/parity testy. Číslování migrace, UI cutover, provider aktivace, staging a jakýkoli backfill zůstávají samostatnými schvalovacími hranicemi.
