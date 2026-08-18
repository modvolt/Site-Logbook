# FÁZE 13.8G-A – offline recovery ceremony

- **Datum dokončení:** 2026-08-03.
- **Implementační commit:** `8cfb142b6ea5c393bd64094bd2c1173e649e90bb`.
- **Formát:** `modvolt-recovery-mnemonic/v1`.
- **Verdikt implementace:** **LOCAL IMPLEMENTATION PASS**.
- **Verdikt publikace:** **BLOCKED – aktuální dependency audit není zelený**.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Výsledek

Vznikl samostatný lokální příkaz `pnpm recovery:ceremony`, který generuje recovery
materiál až na důvěryhodném offline počítači. Recovery materiál nebyl v této fázi
vygenerován, zobrazen, uložen ani přenesen.

Nástroj má dva režimy:

- `generate` vytvoří 24slovný English BIP-39 mnemonic, nezávislou osmislovnou
  passphrase, 32bajtový keyring klíč a jeho veřejný SHA-256 fingerprint;
- `verify` znovu odvodí klíč z maskovaného TTY vstupu a vyžaduje shodu celého
  očekávaného fingerprintu. Klíč vypíše pouze při současném použití
  `--show-derived-key` a `--acknowledge-secret-output`.

Jde úmyslně o offline CLI, nikoli obrazovku produkční webové aplikace. Aplikační server,
prohlížeč, Coolify ani databáze proto mnemonic nebo passphrase vůbec nepotřebují znát.

## Kryptografický kontrakt

1. Mnemonic vzniká z 256 bitů kryptograficky náhodné entropie a obsahuje 24 slov z
   English BIP-39 wordlistu.
2. Passphrase vzniká samostatně z osmi náhodných slov stejného 2048slovného wordlistu.
   Každé slovo používá nezávislých 11 bitů, celkem přibližně 88 bitů entropie.
3. Standardní BIP-39 seed s touto passphrase vstupuje do HKDF-SHA256.
4. HKDF salt je `modvolt-recovery-mnemonic/v1`; info obsahuje formát, účel
   `application|backup`, přesné `key ID` a účel klíče `aes-256`.
5. Výsledkem je přesně 32 bajtů v kanonickém Base64, kompatibilních se současným
   parserem aplikačního i backup keyringu.

Účel a `key ID` jsou součástí odvození. Recovery karta proto musí zachovat přesně
formát, účel, `key ID` a fingerprint. Aplikační a backup keyring musí mít dvě nezávislé
ceremonie s odlišným mnemonicem i passphrase.

## Bezpečnostní hranice

CLI selže uzavřeně, pokud:

- vstup nebo výstup není interaktivní TTY;
- běží v `CI=true` nebo `NODE_ENV=production`;
- prostředí obsahuje DB, provider nebo aplikační secrets;
- chybí potvrzení offline režimu a fyzicky odděleného uložení;
- argument je neznámý, duplicitní nebo se někdo pokusí předat mnemonic či passphrase
  na příkazové řádce;
- mnemonic, passphrase, účel, `key ID` nebo očekávaný fingerprint neodpovídá kontraktu.

Operační zdroj nepoužívá souborový ani síťový klient. Po záznamu se terminál vyčistí
ANSI sekvencí; úplné vymazání JavaScript stringů, paměti operačního systému nebo
historie terminálového programu však nelze zaručit. Ceremonie proto musí proběhnout na
důvěryhodném offline počítači a mnemonic s passphrase musí být fyzicky oddělené.

Existující produkční náhodné keyring klíče nelze zpětně převést na nový mnemonic.
Přechod vyžaduje samostatně schválenou rotaci, backfill a restore drill; tato fáze nic z
toho neprovedla.

## Změněný rozsah

- `scripts/recovery-ceremony-core.mjs` – generování, validace, derivace a bezpečný
  souhrn;
- `scripts/recovery-ceremony.mjs` – interaktivní fail-closed CLI;
- `scripts/test/recovery-ceremony.test.mjs` – deterministické a negativní testy;
- `scripts/run-hermetic-gate.mjs` – recovery test je součástí release gate;
- `package.json`, `pnpm-lock.yaml` – přesně připnutý `@scure/bip39@2.2.0` a příkazy;
- `docs/audit/08-secret-encryption-runbook.md` – operační postup a omezení.

## Ověření

### Prošlo

- `pnpm test:recovery-ceremony`: **11/11 PASS**;
- help-only smoke test: **PASS**, bez vytvoření tajemství;
- cílený ESLint nových a změněných skriptů: **PASS**;
- `pnpm gate:release`: **PASS**;
  - TypeScript typecheck čtyř workspace projektů;
  - bezpečnostní a staging Node testy **29/29**;
  - frontend testy **127/127**;
  - live-events testy **15/15**;
  - API unit testy **316/316**;
  - API a frontend production build;
- `pnpm test:staging-contract`: **16/16 PASS**;
- `pnpm gate:staging-runtime`: **PASS**;
- `git diff --check`: **PASS**;
- cílený scan staged cest: bez private key, GitHub tokenu, AWS access key, `.env` a
  migrace `0100`.

Test používá veřejný BIP-39 zero-entropy vektor `abandon ... art`; nejde o reálný
recovery secret a produkční použití by bylo zakázané.

### Blokátor quality gate

`pnpm gate:quality` dokončil lint i peer kontrolu, ale `pnpm audit
--audit-level=moderate` selhal na aktuálním registry stavu:

- 0 critical, 3 high, 3 moderate a 1 low;
- advisory `1123528` v `@babel/core`;
- advisory `1130736` v `brace-expansion`;
- advisory `1130720` v `fast-uri`;
- advisories `1130722`, `1130723` a `1130724` v `ip-address`;
- advisory `1130709` v `postcss`.

Žádná hlášená cesta nevede přes nový `@scure/bip39`. Lockfile diff přidává pouze jeho
nové uzly `@scure/bip39`, `@scure/base` a `@noble/hashes`; existující transitivní verze
nepřepisuje. Nález je přesto blokátorem nového exact-SHA GitHub Quality gate a image
publication. V této úzké fázi nebyly bez samostatného posouzení provedeny nesouvisející
dependency upgrady ani overrides.

## Negativní důkazy

- žádný skutečný mnemonic, passphrase, keyring klíč ani secret nebyl vygenerován;
- žádný secret nebyl přijat z argumentu, env, souboru, prohlížeče nebo chatu;
- nebyl proveden push, PR změna, workflow dispatch, GHCR write ani změna visibility;
- nebyl kontaktován Coolify, S3, DNS, staging runtime ani produkce;
- nebyla spuštěna DB, migrace, restore, backfill ani rotace klíčů;
- publikovaný kandidát zůstává `aacb767be933e3589b40066f33d8ee0bac8939f4`;
  nová lokální implementace `8cfb142…` dosud publikovaná není.
