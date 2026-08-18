# FÁZE 13.8G-A – checkpoint

- **Datum:** 2026-08-03.
- **Stav:** **DOKONČENO LOKÁLNĚ / PUBLIKACE BLOKOVÁNA QUALITY AUDITEM**.
- **Implementační commit:** `8cfb142b6ea5c393bd64094bd2c1173e649e90bb`.
- **Remote větev:** beze změny na publikovaném kandidátu
  `aacb767be933e3589b40066f33d8ee0bac8939f4`.
- **`main`:** bez autorizované změny.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Uložené výstupy

- [recovery ceremony a evidence](13-8g-a-recovery-ceremony.md)
- [aktualizovaný secret-encryption runbook](08-secret-encryption-runbook.md)

## Shrnutí

Po schválení vznikl samostatný offline recovery průvodce. Program generuje 24slovný
BIP-39 mnemonic a oddělenou osmislovnou passphrase až při lokální interaktivní ceremonii,
odvozuje 32bajtový keyring klíč doménově odděleným verzovaným kontraktem a umožňuje
nezávislé ověření přes celý SHA-256 fingerprint. Aplikační a backup recovery zůstávají
oddělené.

Recovery materiál v tomto běhu vytvořen nebyl. Všechny funkční, negativní, typecheck,
unit, build a staging contract kontroly prošly. Celkový quality gate však není zelený,
protože čerstvý registry audit hlásí sedm transitivních advisories mimo nový
`@scure/bip39`. Nový commit se proto nesmí zatím publikovat ani použít pro image build.

## Nejasnosti a blokery

- je nutné zvolit nejmenší kompatibilní upgrade/override pro advisories `1123528`,
  `1130736`, `1130720`, `1130722`–`1130724` a `1130709` a ověřit jejich runtime dopad;
- po opravě musí znovu projít celý `gate:quality` a `gate:release`;
- lokální `8cfb142…` mění source SHA proti dosud publikovanému a zelenému `aacb767…`;
- push nového přesného rozsahu a následný GHCR write nemají v tomto checkpointu nové
  samostatné oprávnění;
- skutečné recovery karty a fyzické custody umístění zatím neexistují; vzniknou až při
  budoucí offline ceremonii mimo chat a běžný aplikační runtime.

## Jednoznačný checkpoint

FÁZE 13.8G-A zde končí. Lokální recovery program, testy, runbook a evidence jsou hotové.
Tento checkpoint neautorizuje dependency remediation, push, PR změnu, workflow
dispatch, GHCR package write, změnu package visibility, Coolify/S3/DNS provisioning,
vložení secrets, spuštění recovery ceremonie, image pull, runtime start, DB, migraci
`0100`, restore/backfill, deploy, merge ani produkční zásah. Automaticky se nepokračuje
do F13.8G-B.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8G-B – úzká remediation aktuálních dependency advisories a
  obnova zeleného exact-SHA publication gate;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** jde o supply-chain rozhodnutí napříč produkčními a
  build-only transitivními závislostmi, kde nesmí oprava změnit síťové validační chování,
  build artefakty ani rozšířit rollout o neověřený image nebo deploy;
- **očekávané činnosti:** zmapovat všech sedm advisory cest a jejich patched verze,
  zvolit nejmenší kompatibilní přímý upgrade nebo přesný override, spustit cílené testy,
  celý `gate:quality`, `gate:release` a staging kontrakty, vytvořit nový lokální exact-SHA
  checkpoint a teprve po samostatném souhlasu publikovat přesný commit na PR větev a
  ověřit nový GitHub Quality gate;
- **soubory, které budou pravděpodobně změněny:** `package.json`, `pnpm-lock.yaml`,
  případně přímo dotčené workspace `package.json` a `docs/audit/13-8g-b-*`; aplikační
  zdroj pouze pokud test prokáže nezbytnou kompatibilní úpravu;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat
  DB ani migraci `0100`, Coolify/S3/DNS, secrets, recovery ceremonii, runtime start,
  deploy, merge nebo produkční změnu. Dependency/lockfile změny jsou supply-chain
  riziko; případný Git push je externí zápis vyžadující výslovný souhlas a GHCR
  publication musí zůstat samostatným pozdějším gate.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
`Pokračuj další fází`.
