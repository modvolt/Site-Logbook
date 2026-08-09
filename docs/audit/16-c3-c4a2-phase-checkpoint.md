# Checkpoint R16-C3C4A2 – důkaz obnovitelnosti po exact `0104`

Datum: 2026-08-09

## Výsledek

**R16-C3C4A2 je implementována a lokálně ověřena jako pouze kódová, read-only
evidence gate. Nebyla vytvořena ani obnovena žádná živá záloha, nebyl spuštěn
Docker staging, workflow dispatch, GHCR zápis, migrace, deploy ani zásah do
produkce.**

Implementační commit je
`51380b2e87df3b598cc12c8ad954d6f791aec1eb`.

Nová řídicí vrstva:

- přijímá pouze kanonické baseline input a execution artefakty se shodnými GNU
  checksum soubory a dvěma samostatně schválenými SHA-256;
- ověřuje celou baseline posloupnost precheck → případný fixed predecessor
  migrator → exact-0104 postcheck, včetně varianty bezpečného `verified-noop`;
- vyžaduje novější `backup_log.id` a čas vytvoření zálohy striktně po dokončení
  baseline;
- v read-only repeatable-read transakci pod existujícím migračním advisory lockem
  znovu prokazuje přesně 104 aplikovaných migrací s tail
  `0104_thin_sheva_callister`, absenci `0100` i `0105`, staging DB identitu a
  nulový external-account stav;
- přijímá pouze nejnovější úspěšnou, neprázdnou, SHA-256 svázanou a `mve1`
  šifrovanou zálohu s úspěšným restore testem, kladnou délkou testu a neprázdnou
  mapou ověřených tabulek;
- tvrdě odmítá chybějící `restored_at`; evidence je platná pouze při explicitním
  `NULL`, tedy bez destruktivního restore nad zdrojovou staging DB;
- do evidence ukládá pouze digest šifrovaného payloadu, fingerprint object path,
  fingerprint key ID, časové údaje a hash kanonických počtů tabulek; nekopíruje
  object path, key ID, `DATABASE_URL` ani raw table counts;
- rekurzivně odmítá secret-shaped pole a URL credentials v převzatých
  artefaktech, vyžaduje přesné sady klíčů a z PASS markeru kopíruje jen explicitně
  povolená pole;
- spouští se pouze ručně v profile-only službě
  `exact-0104-recovery-gate`, bez portů, mountů, dependencies nebo build surface;
- před i po one-shot gate vyžaduje, aby jedinou běžící službou izolovaného
  Compose projektu byl `postgres`;
- zapisuje kanonické execution evidence a checksum atomicky a bez přepisu;
- končí stavem `authorizes0105=false` a vyžaduje nový samostatný transition
  binding před jakoukoli budoucí `0105` operací.

Migrace `0100` zůstává výslovně nezařazena.

## Změněná plocha

- DB validátor a read-only recovery dotaz v
  `lib/db/src/external-schema-preflight.ts`;
- nový strict runtime kontrakt
  `lib/db/src/staging-exact-0104-recovery.ts`;
- nový API one-shot entrypoint a jeho build registrace;
- nový binding generátor, host runner, Compose profil a env příklady;
- cílené unit/mutation testy, rozšířený staging runtime kontrakt a runbook.

Produkční Coolify resource, produkční DB, S3, DNS, secrets a GHCR se nezměnily.

## Provedené kontroly

- cílené Node recovery/runtime testy: 32/32 PASS;
- DB external-schema/recovery sada: 21/21 PASS;
- `pnpm run typecheck:libs`: PASS;
- API TypeScript kontrola: PASS;
- API build mimo sandbox: PASS; vznikl bundle
  `dist/external-schema-exact-0104-recovery.mjs`;
- `pnpm gate:staging-runtime`: PASS;
- strict YAML parse s unikátními klíči: PASS;
- Prettier kontrola změněných formátovatelných souborů: PASS;
- `pnpm gate:quality`: PASS; lint, peer dependency kontrola a dependency audit od
  úrovně moderate jsou bez nálezu;
- `git diff --check`: PASS.

Celá `pnpm test:staging-contract` sada skončila 79 PASS a 10 FAIL. Všech deset
neúspěchů má jedinou environmentální příčinu: lokálně chybí pinned offline image
`site-logbook/workflow-harness:alpine-3.22.1-7b2d54e4ed3722df`. Nejde o pozorovanou
chybu recovery implementace. Po pushi musí přesný finální head projít vzdáleným
Quality gate, který pinned harness připravuje a spouští.

## Nejasnosti a zbývající hranice

1. Kódová existence recovery gate není důkazem živé zálohy ani oprávněním runner
   spustit. Exact-0104 baseline, vytvoření nové zálohy a skutečný restore test
   zatím provedeny nebyly.
2. Fixed predecessor image zatím nebyla publikována. Private wrapper je na
   private `main`, ale uživatel výslovně neschválil workflow dispatch ani GHCR
   zápis.
3. Aktuální `gh` token má repo/workflow oprávnění, ale stále nemá
   `read:packages`; aktuální GHCR inventuru proto nelze před budoucím dispatch
   bezpečně potvrdit.
4. Lokální Docker harness nebyl kvůli chybějící image ani stabilitě počítače
   připravován. Přesný vzdálený Quality gate musí tuto mezeru uzavřít.
5. Tato podfáze neautorizuje `0105`, feature flag, Coolify staging deploy ani
   produkční změnu. `0100` zůstává nezařazena.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C – po novém samostatném výslovném souhlasu jednorázově
  spustit fixed predecessor publisher z private `main`, ověřit immutable GHCR
  evidence a zastavit bez deploye;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: další fáze může provést první externí a prakticky
  nevratný GHCR zápis a musí přesně ověřit zdrojový commit/tree, jediný
  `linux/amd64` digest, provenance, SBOM, package/version ID a checksum;
- očekávané činnosti: obnovit pouze read-only `read:packages`, úplně načíst
  aktivní i viditelně smazanou inventuru, znovu ověřit public exact-head green
  CI a private wrapper, a teprve po samostatném souhlasu případně provést jediný
  dispatch a nezávisle ověřit jeho artifact;
- soubory, které budou pravděpodobně změněny: žádný produkční soubor; pouze nový
  auditní checkpoint. GitHub Actions může vytvořit evidence artifact a nejvýše
  jednu privátní GHCR package verzi;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migrace a
  deploy jsou zakázány. Může obsahovat jediný výslovně schválený externí GHCR
  zápis, pokud exact tag před spuštěním chybí.

## Stop

Checkpoint R16-C3C4A2 je vytvořen. Publisher, živý baseline/restore, `0105`,
deploy i produkce zůstávají zastavené za samostatnými schvalovacími branami.
