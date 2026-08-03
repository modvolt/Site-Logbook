# FÁZE 13.8G-B – dependency advisory remediation

- **Datum dokončení:** 2026-08-03.
- **Výchozí checkpoint:** `954de25d00520e4972c98f4d1cdab43d4128ecd1`.
- **Remediation commit:** `da495d01b99ac779331cd2ca128d1540605352ec`.
- **Verdikt:** **LOCAL QUALITY / RELEASE / STAGING CONTRACT PASS**.
- **Registry audit:** **0 známých zranitelností i při `--audit-level=low`**.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Odstraněné nálezy

| Advisory                                                                 | Balík               | Závažnost | Původní verze | Opravená verze | Provozní oblast                          |
| ------------------------------------------------------------------------ | ------------------- | --------- | ------------- | -------------- | ---------------------------------------- |
| [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) | `@babel/core`       | low       | `7.29.0`      | `7.29.6`       | lint, React a Workbox build              |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `brace-expansion@2` | high      | `2.1.3`       | `2.1.4`        | PWA build                                |
| [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) | `fast-uri`          | high      | `3.1.4`       | `3.1.5`        | AJV, PWA build a API codegen             |
| [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) | `ip-address`        | high      | `10.2.0`      | `10.3.1`       | produkční API rate limiting a IMAP/SOCKS |
| [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh) | `ip-address`        | moderate  | `10.2.0`      | `10.3.1`       | produkční API rate limiting a IMAP/SOCKS |
| [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | `ip-address`        | moderate  | `10.2.0`      | `10.3.1`       | produkční API rate limiting a IMAP/SOCKS |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss`           | moderate  | `8.5.18`      | `8.5.23`       | frontend build a test tooling            |

Produkční runtime přímo zasahuje pouze `ip-address`: používají jej
`express-rate-limit` a `imapflow > socks`. Ostatní nálezy byly v lint, build, test nebo
codegen grafu. Oprava PostCSS legitimně posunula jeho transitivní `nanoid` z `3.3.12` na
`3.3.16`.

## Zvolená remediation

Projekt již udržuje centrální bezpečnostní override blok v `pnpm-workspace.yaml`.
Změna proto:

- připíná `@babel/core@7` na `7.29.6`, bez zásahu do budoucí major řady 8;
- mění jen zranitelnou `brace-expansion@2` větev na `2.1.4`; bezpečná větev 5 zůstává
  `5.0.9`;
- připíná `fast-uri` na `3.1.5`, `ip-address` na `10.3.1` a `postcss` na `8.5.23`;
- nemění parent balíky, jejich major verze ani aplikační zdroj.

Všechny nové verze leží v deklarovaných parent semver rozsazích. Registry integrita byla
ověřena před instalací a všechny releasy byly starší než projektová 24hodinová
`minimumReleaseAge` karanténa; nebyla přidána žádná výjimka.

Pnpm při Babel override mechanicky přepsal peer resolution kontexty, takže lockfile diff
má 708 řádků. Porovnání skutečné množiny `packages:` však našlo jen těchto šest přesných
verzových změn:

```text
@babel/core       7.29.0  -> 7.29.6
brace-expansion   2.1.3   -> 2.1.4
fast-uri          3.1.4   -> 3.1.5
ip-address        10.2.0  -> 10.3.1
postcss           8.5.18  -> 8.5.23
nanoid            3.3.12  -> 3.3.16
```

Širší parent update a necílený `pnpm update` byly odmítnuty: experimentální lockfile-only
pokus aktualizoval mnoho nesouvisejících balíků a byl před commitem zcela zahozen. Do
uloženého diffu se nedostal.

## Ověření

- frozen install a supply-chain policy: **PASS**;
- `pnpm audit --audit-level=low`: **PASS, 0 vulnerabilities**;
- `pnpm peers check`: **PASS**;
- `pnpm gate:quality`: **PASS**;
- `pnpm gate:release`: **PASS**;
  - TypeScript typecheck čtyř workspace projektů;
  - bezpečnostní a staging Node testy **29/29**;
  - frontend testy **127/127**;
  - live-events testy **15/15**;
  - API unit testy **316/316**;
  - API a frontend/PWA production build;
- `pnpm --filter @workspace/api-spec codegen`: **PASS**, generované Git blob hashe beze
  změny;
- `pnpm test:staging-contract`: **16/16 PASS**;
- `pnpm gate:staging-runtime`: **PASS**;
- `git diff --check`: **PASS**;
- staged scope: pouze `pnpm-workspace.yaml` a `pnpm-lock.yaml`, bez `.env`, credentials a
  migrace `0100`.

## Agentní rozdělení

Tři pomocní agenti provedli nezávislé read-only mapování advisory cest, parent semver
kompatibility a primárních GHSA zdrojů. Žádný agent neměnil soubor, neinstaloval balík,
nepushoval ani nekontaktoval staging či produkci. Lockfile měl jediného autora v hlavním
pracovním toku.

## Negativní důkazy

- nebyl změněn aplikační backendový ani frontendový zdroj;
- nebyla spuštěna DB, migrace, restore, backfill nebo recovery ceremony;
- nebyl vygenerován, čten ani změněn žádný secret;
- nebyl proveden push, PR změna, workflow dispatch, GHCR write ani změna visibility;
- nebyl kontaktován Coolify, S3, DNS, staging runtime ani produkce;
- publikovaný remote kandidát zůstává `aacb767be933e3589b40066f33d8ee0bac8939f4`;
  lokální remediation `da495d0…` dosud publikovaná není.
