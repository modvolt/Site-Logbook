# FÁZE 13.8G-B – checkpoint

- **Datum:** 2026-08-03.
- **Stav:** **DOKONČENO LOKÁLNĚ – QUALITY / RELEASE / STAGING CONTRACT PASS**.
- **Remediation commit:** `da495d01b99ac779331cd2ca128d1540605352ec`.
- **Audit:** 0 známých zranitelností na prahu `low`.
- **Remote větev:** beze změny na publikovaném kandidátu
  `aacb767be933e3589b40066f33d8ee0bac8939f4`.
- **`main`:** bez autorizované změny.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Uložené výstupy

- [dependency remediation a evidence](13-8g-b-dependency-remediation.md)
- [předchozí recovery ceremony evidence](13-8g-a-recovery-ceremony.md)
- [předchozí checkpoint](13-8g-a-phase-checkpoint.md)

## Shrnutí

Všech sedm advisories z F13.8G-A bylo odstraněno pěti patch upgrady bez major parent
upgradu a bez změny aplikačního zdroje. Jediný produkční runtime balík v rozsahu byl
`ip-address`, používaný rate limitery a IMAP/SOCKS grafem API; celý API unit balík i build
prošly. Ostatní opravy chrání lint, PWA build, testy a codegen.

Quality, release a staging contract gates jsou lokálně zelené. API codegen nevytvořil
obsahový drift. Pnpm supply-chain karanténa zůstala zachována a nebyla přidána výjimka.

## Nejasnosti a zbývající gate

- lokální větev nyní obsahuje recovery program a dependency remediation nad dosud
  publikovaným `aacb767…`; GitHub zatím toto nové exact SHA nezná;
- před jakýmkoli image buildem musí být přesně definovaný lokální commit rozsah
  publikován na existující PR větev a musí pro něj projít nový exact-SHA GitHub Quality
  gate;
- push tohoto nového rozsahu nemá v tomto checkpointu samostatný výslovný souhlas;
- GHCR write, image workflow a Coolify deploy zůstávají dalšími oddělenými gates.

## Jednoznačný checkpoint

FÁZE 13.8G-B zde končí. Dependency remediation, lokální testy a evidence jsou hotové.
Tento checkpoint neautorizuje push, PR změnu, workflow dispatch, GHCR package write,
změnu package visibility, Coolify/S3/DNS provisioning, vložení secrets, spuštění recovery
ceremonie, image pull, runtime start, DB, migraci `0100`, restore/backfill, deploy, merge
ani produkční zásah. Automaticky se nepokračuje do F13.8G-C.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8G-C – publikace přesného lokálního commit rozsahu na staging
  PR větev a nový exact-SHA GitHub Quality gate, stále bez image publication a deploye;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** jde o externí Git zápis a supply-chain gate, kde musí
  zůstat shodný lokální commit, remote head, PR head a CI SHA a nesmí se omylem spustit
  image workflow, merge nebo deploy;
- **očekávané činnosti:** read-only ověřit remote PR head a `main`, vypsat přesný
  fast-forward commit rozsah od `aacb767…`, vyžádat výslovný souhlas k tomuto rozsahu,
  pushnout pouze exact refspec bez force, sledovat nový GitHub Quality gate a ověřit jeho
  exact head SHA a zelené joby;
- **soubory, které budou pravděpodobně změněny:** při čistém průchodu pouze
  `docs/audit/13-8g-c-*`; workflow nebo aplikační soubor pouze po novém úzkém schválení,
  pokud CI odhalí konkrétní problém;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat DB,
  migraci `0100`, secrets, GHCR write, Coolify/S3/DNS, runtime start, deploy, merge ani
  produkční změnu. Může obsahovat výslovně schválený Git push a GitHub CI běh, což jsou
  externí a auditovatelné změny.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
`Pokračuj další fází`.
