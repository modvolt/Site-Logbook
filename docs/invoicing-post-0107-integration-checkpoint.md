# Fakturace 0108 po dokončení produkčního přechodu 0107

Aktualizováno: 2026-08-23

## Stav

Tento dokument je integrační checkpoint, nikoli potvrzení o nasazení. V této
větvi nebyl proveden push, workflow dispatch, produkční DB zápis ani deployment.

- Autoritativní veřejný základ s opravou production activation/loginu:
  `8787d7fc9fc28df2bccb4300b4ad484d16c87c05`.
- Integrovaná fakturace nad tímto základem: `32fb8ec`.
- Samostatný lokální exact-0108 release chain: `cf64cc1`.
- Pracovní větev: `agent/invoice-0108-on-8787`.
- Login/activation soubory byly převzaty z veřejného merge základu; fakturační
  integrace je nepřepisuje starší variantou.
- Produkce je podle koordinačního checkpointu na `0107`; před prvním zápisem se
  tento údaj musí znovu potvrdit read-only inventurou nového produceru.

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

Samostatná source-pinned 0108 autorita nyní provede přesně čtyři granty až po
durable migration receiptu. Výsledek je znovu read-only promítnut a uložen jako
no-clobber role receipt. Samotný kontrakt nadále neautorizuje start aplikace.

## Release brány po finálním 0107 checkpointu

1. **Neměnný základ – lokálně hotovo, publikace čeká**
   - větev je založená přímo na veřejném merge `8787d7f`;
   - celý lokální gate je zelený;
   - push/PR, merge a digesty nových image zatím nevznikly.
2. **Nový pre-0108 recovery bod – implementován, produkční běh čeká**
   - nový control-plane one-shot nejdřív ověří exact `0107` a zastavené runtime
     DB relace;
   - vytvoří existující šifrovanou `mve1` zálohu bez retention prune a ze stejného
     exportovaného snapshotu změří všechny aplikační tabulky;
   - zálohu obnoví do dočasné DB a porovná všechny počty tabulek;
   - teprve potom no-clobber uloží exact receipt a reference; ani jeden artefakt
     sám neautorizuje migraci nebo start aplikace;
   - čerstvý produkční běh a jeho skutečné artefakty zatím neproběhly.
3. **Samostatný přechod 0107 -> 0108 – implementován, produkční běh čeká**
   - samostatný source-pinned runner aplikuje právě jedinou 0108 transakci;
   - nejasný COMMIT/ROLLBACK je terminální `RESTORE_REQUIRED`, bez blind retry;
   - role delta následuje až po durable migration receiptu;
   - exact inventura vyžaduje 108 známých migrací, dvě opaque identity a zákaz
     `0100`.
4. **0108 startup/release evidence – implementováno, skutečný bundle čeká**
   - protokol v3 váže build SHA, zálohu, plán, intent, migration receipt, role
     receipt, live readiness a attended start approval;
   - runtime 0108 odmítne starý v2/exact-0107 bundle i starý build SHA;
   - nový podepsaný produkční bundle ještě nebyl vytvořen ani přenesen na host.
5. **Lokální databázové brány – PostgreSQL 18 hotovo, exact PG16 čeká**
   - disposable PostgreSQL 18 ověřil forward `0107 -> 0108`, nejmenší oprávnění,
     DOWN a druhý forward;
   - na novém disposable PostgreSQL 18 prošel cílený DB souběh: 1 soubor,
     11/11 scénářů rezervace, dvojího vystavení, storna a opakovaného vystavení;
   - exact PostgreSQL 16 lifecycle zůstává skip, dokud není dostupný schválený
     izolovaný PG16/Docker endpoint;
   - Quality workflow už má vlastní disposable PG16 kontejner a explicitní
     `0107 -> 0108 -> DOWN -> 0108` krok; jeho první skutečný běh čeká na PR.

## Přesný zbývající release postup

1. Po samostatném schválení publikovat větev/PR; bez workflow dispatch. CI musí
   znovu ověřit celý release gate a exact PostgreSQL 16 lifecycle.
2. Po merge ověřit exact-SHA Quality a publikovat digestové runtime,
   control-plane a host-operator image.
3. V maintenance window zastavit aplikační writer, spustit nový exact-0107
   backup+disposable-restore one-shot a zachovat receipt/reference.
4. Spustit `prepare`, jednu 0108 transakci, role delta a read-only readiness;
   při nejasném výsledku nic neopakovat a řídit se klasifikací recovery.
5. Vytvořit attended approval a podepsaný v3 activation bundle, přenést jej
   samostatným V3 host commandem a teprve potom nasadit runtime image.
6. Ověřit login, health, běžnou fakturu bez zakázky, zálohovou fakturu a vazby
   přijatého dokladu/dodacího listu v produkčním smoke testu.

## Aktuálně ověřeno lokálně

- Node hermetické kontrakty: 330 celkem, 329 pass, 1 PG16 skip, 0 fail;
- activation/DB kontrakty: 33 celkem, 30 pass, 3 PG16 skip, 0 fail;
- nový exact-0107 backup producer: 3/3;
- exact-0107 backup authority: 3/3;
- frontend/PWA unit: 193/193;
- live-events: 15/15;
- API unit: 1070 celkem, 1069 pass, 1 skip;
- TypeScript, ESLint, API build a diff-check: úspěšné;
- disposable PostgreSQL 18 0107/0108 lifecycle: úspěšný;
- disposable PostgreSQL 18 DB concurrency: 1 soubor, 11/11 testů;
- převzaté Phase-0 vazby přijatá faktura/dodací list/zakázka/materiál a
  automatické párování: 4 izolované DB soubory, 66/66 testů;
- syntaxe Quality workflow a fail-closed zapojení exact PG16 0108 gate: úspěšné,
  samotný PG16 lifecycle zatím lokálně neproveden.

Tyto výsledky dokazují lokální implementaci. Nedokazují nový CI run, publikaci
image, skutečný produkční backup, migraci, deployment ani přihlášený live smoke.
