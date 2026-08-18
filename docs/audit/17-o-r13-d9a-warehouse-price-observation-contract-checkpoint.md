# R13-D9A – warehouse-price observation contract checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako čistý fail-closed kontrakt; bez DDL, persistence a runtime aktivace; R13 jako celek NOT READY**

## Výsledek

R13-D9A zavádí strict canonical kontrakt `site-logbook.warehouse-price-observation/v1` pro budoucí append-only historii nákupní ceny. Kontrakt zatím nic nezapisuje do databáze a nemění current skladovou projekci.

- každá observation má stable UUID, item-local monotónní sequence, digest předchozího kroku a explicitní supersession;
- source binding exactně váže incoming cost-document aggregate, accounting version ID/hash, lifecycle event ID/hash a source line ID;
- `observed` je povoleno jen nad `approved` version/eventem, `corrected` jen nad `correction` version a `correction_linked` eventem a `withdrawn` jen nad `review_reopened` eventem;
- cena je canonical decimal bez trailing zeroes, nejvýše se čtyřmi desetinnými místy, měna musí odpovídat accounting snapshotu a source line musí být `material`;
- withdrawal cenu ani warehouse-match nenese. Correction cenu znovu váže na nový immutable line snapshot;
- actor, reason code/digest a oba časy musí přesně odpovídat lifecycle eventu;
- integrity používá domain-separated SHA-256 nad canonical JSON a verifier odmítá změněný obsah, extra klíče i nekanonické raw bytes.

## Řetězec a korekce

První observation má sequence `0` a nemá predecessor ani superseded ID. Každý další krok musí:

1. pokračovat na stejném warehouse itemu přes sequence + 1;
2. nést přesný digest bezprostředního předchozího kroku;
3. odkázat na starší observation, kterou superseduje;
4. withdrawal svázat se stejným dokumentem, accounting version a source line;
5. corrected cenu vložit až po withdrawal a pouze pro stejný document aggregate.

Tento model dovoluje, aby correction po znovuotevření použila nový line ID, ale nepovolí přesun řetězce mezi dokumenty nebo skladovými položkami. Current `warehouse_items.purchase_price` zůstává pouze budoucí odvoditelnou projekcí, nikoli důkazem historie.

## Co záměrně ještě není implementováno

- Drizzle tabulka, FK, unique constraint, append-only trigger ani SQL template;
- DB adapter, transaction-owned writer, outbox/export binding a fault/replay testy;
- parity checker proti `warehouse_price_history` a controlled legacy backfill;
- přepnutí `approveDocument`/reopen/reapprove callerů na nový ledger;
- odstranění D8 price-history guardu;
- číslovaná migrace, staging či produkční data change.

Legacy `warehouse_price_history` proto zůstává mutable projection a D8 správně dál blokuje correction reopen dokladu, který ji už obsahuje. Samotná existence tohoto kontraktu neopravňuje guard vypnout.

## Ověření

- cílené source/chain/integrity mutation testy: **5/5 PASS**;
- celý API unit/contract balík: **99 souborů, 761/761 PASS**;
- API typecheck a scoped ESLint: **PASS**;
- Prettier pro nový kontrakt a test: **PASS**;
- nevznikl commit, push, PR, workflow dispatch, GHCR/S3 zápis, deploy, backfill ani staging/produkční migrace.

## Navazující hranice

Bez další business volby lze bezpečně připravit pouze nečíslovaný additive DB návrh a persistence kontrakt pro tento ledger. Aktivace callerů, parity/backfill a odstranění D8 guardu jsou samostatné rizikové checkpointy.

Implementace `ignored`/discard větve a čitelného reason note nadále čeká na dvě rozhodnutí z `17-n-r13-d9-ignored-reason-price-provenance-design.md`:

1. early junk discard versus reviewed immutable rejection;
2. restricted bounded readable note versus reason code + digest only.

## Následné hardening

R13-D9D následně opravil příliš úzký invariant první observation: prázdný item stream smí začít také `corrected`, pokud correction nově vytvoří nebo přesune materiál na danou skladovou kartu; první `withdrawn` zůstává zakázán. Historický D9A text výše popisuje původní stav před touto opravou. Aktuální projection a testovací kontrakt je v `17-r-r13-d9d-warehouse-price-projection-checkpoint.md`.
