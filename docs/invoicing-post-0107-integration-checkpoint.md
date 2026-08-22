# Fakturace 0108 po dokončení produkčního přechodu 0107

Datum rehearsal: 2026-08-18

## Stav

Tento dokument je integrační checkpoint, nikoli povolení k nasazení. Produkce
zůstala při jeho přípravě read-only a žádná migrace, změna role, deployment,
push ani PR nebyly provedeny.

- Poslední lokálně dostupný čistý základ produkčního proudu: `8300469`.
- Aktivní úkol Fáze 0 nad tímto základem stále dokončuje P1 opravy; pracovní
  strom ani PR stack proto ještě nejsou autoritativní základ pro fakturaci.
- Původní čistý fakturační checkpoint: `1f5f7ef`.
- Rehearsal větev: `agent/invoicing-after-8300469-20260818`.
- Rehearsal přenesl commity `b3f5721`, `6e51d10`, `1f5f7ef` bez konfliktu.
- Souborový překryv fakturačních změn s commitnutými i tehdy rozpracovanými
  změnami produkčního proudu byl nulový. Na finálním SHA se musí přepočítat.

## Migrační linie

- Produkční proud končí `0107_canonical_audit_evidence`.
- Fakturační změna přidává jedinou
  `0108_invoice_source_allocations_and_advances`.
- `0108_snapshot.prevId` přesně odpovídá `0107_snapshot.id`.
- Journal má 108 známých položek a neobsahuje vynechanou `0100`.
- Pokud finální Fáze 0 přidá další schema migraci, `0108` už není použitelné
  číslo ani snapshot. Migrace se musí znovu vygenerovat nad novým předchůdcem.

## Opravené integrační kolize v rehearsal

### Uzavřený runner 0096 -> 0107

Historický produkční adapter původně vyžadoval, aby celý aktivní journal měl
přesně 107 položek. Přidání `0108` proto blokovalo i čistě lokální release gate.
Rehearsal nyní:

- validuje přesně zmrazený prefix 107 migrací do `0107`;
- kontroluje v celém journalu zákaz `0100` a validní pořadí suffixu;
- SQL a cílový digest počítá pouze ze zmrazeného prefixu;
- nikdy nezařadí `0108` jako krok starého runneru.

Starý runner tím není oprávněn ani připraven aplikovat `0108`.

### Oddělená runtime DB role

Po exact-0107 role ceremony jsou budoucí objekty default-dark. `0108` vytváří
tabulku `invoice_source_allocations` a serial sekvenci, které by bez dalšího
kontraktu nebyly pro aplikační runtime použitelné.

Nový deaktivovaný kontrakt vyžaduje:

- tabulka: pouze `SELECT`, `INSERT`, `UPDATE` pro runtime;
- sekvence: pouze `USAGE` pro runtime;
- vlastník obou objektů: migrator role;
- žádný `PUBLIC`, třetí role ani column grant;
- žádný `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` nebo DDL grant;
- exact-0107 role projekci a oba nové objekty default-dark jako pre-state.

Kontrakt zatím neposkytuje produkční autorizaci ani samostatný host executor.

## Co musí vzniknout po finálním 0107 checkpointu

1. **Neměnný základ**
   - čistý finální `main` SHA a tree SHA;
   - zelené CI a finální image digesty;
   - potvrzený receipt-backed stav `0107` a dokončený runtime credential
     cutover/smoke test.
2. **Nový pre-0108 recovery bod**
   - read-only inventory přesného živého stavu `0107`;
   - nový backup po zastavení writerů;
   - izolovaný PostgreSQL 16 restore a podepsaný PASS receipt.
3. **Samostatný přechod 0107 -> 0108**
   - nový verzovaný plán, confirmation a receipt; starý runner se nepoužije;
   - atomické provedení právě jedné migrace pod migrator rolí;
   - aplikace grant kontraktu a nezávislá post-commit role projekce;
   - exact kontrola 108 známých řádků, dvou produkčních opaque identit a zákazu
     `0100`.
4. **0108 startup/release evidence**
   - nový evidence schema/version vázaný na finální build SHA;
   - zachovaná validace exact-0107 auditního prefixu;
   - plná validace známého suffixu `0108`, jeho SQL hash a schema fingerprint;
   - odmítnutí starého 0107 evidence pro nový fakturační image.
5. **Lokální databázové brány**
   - disposable forward `0107 -> 0108`;
   - rollback preflight, povolený DOWN na prázdných nových datech a opětovný
     forward;
   - důkaz, že fail-closed rollback blokery skutečně blokují destruktivní DOWN;
   - souběžná rezervace zdrojů a dvojí vystavení na izolované loopback DB.

## Přesný integrační postup po dokončení Fáze 0

1. Načíst finální `main`, ověřit čistý strom a zachytit SHA.
2. Zopakovat migrační diff, file-overlap a snapshot lineage.
3. Vytvořit nový worktree z finálního SHA.
4. Přenést tři fakturační commity v původním pořadí.
5. Přenést nebo znovu aplikovat pouze rehearsal integrační opravy, které jsou
   stále potřeba po finálních P1 změnách.
6. Spustit codegen dvakrát; druhý běh nesmí vytvořit obsahový diff.
7. Spustit typecheck, lint, celý hermetický gate, API/PWA build a focused
   fakturační testy.
8. Spustit disposable PostgreSQL 16 forward/rollback/concurrency brány.
9. Teprve potom připravit samostatný PR. Merge, staging, produkční migrace a
   deployment zůstávají oddělené approval hranice.

## Aktuálně ověřeno v rehearsal

- cherry-pick: bez konfliktu;
- production control-plane: 30/30;
- role 0108 contract: 5/5;
- fakturační unit/contract sada: 52/52;
- frontend unit sada: 191/191;
- TypeScript: úspěšný;
- ESLint: úspěšný;
- API build: úspěšný;
- PWA build: úspěšný;
- Orval/codegen a knihovní TypeScript build: úspěšný.

Celý release gate není na dočasném základu `8300469` autoritativní. Finální
source piny a rozpracovaná host-operator testovací hrana patří do dokončovaného
PR stacku Fáze 0 a musí se ověřit až na jeho výsledném SHA.
