# FÁZE 11 – Ověření object recovery základu

## 1. Výsledek

FÁZE 11 převádí jednorázový object manifest z testu FÁZE 10 na znovupoužitelný,
fail-closed recovery nástroj. Bundle pokrývá celý privátní storage prefix včetně
šifrovaných DB dumpů, šifruje manifest i jednotlivé payloady, odmítá in-place
restore a před zápisem vyžaduje prázdný oddělený cíl a jeho explicitní fingerprint.

Produkce, `modvoltapp.cz`, produkční DB, bucket, secrets, mail, deploy a remote
repository nebyly použity ani změněny. Nebyla přidána migrace.

## 2. Implementace

- `object-recovery.ts`: formát `modvolt-object-recovery/v1`, inventura,
  per-object envelope, šifrovaný manifest, checksum verification a safe restore;
- `objectStorage.ts`: stránkovaná inventura privátního S3 prefixu, GCS inventura,
  secret-free storage identity, existence cíle a čtení s `Content-Type`;
- `secret-envelope.ts`: obecný autentizovaný backup artifact envelope se stejným
  odděleným backup keyringem; existující DB dump formát zůstává kompatibilní;
- `object-recovery.ts` CLI: `identity`, `snapshot`, `verify`, `restore`, absolutní
  cesty, isolated-target guard a target fingerprint;
- `object-recovery.test.ts`: šifrování, přesná obnova, same-store/overwrite guard,
  explicitní potvrzení, tamper detection a cleanup neúplného bundle.

## 3. Lokální S3 integrační drill

- server: MinIO community `RELEASE.2025-09-07T16-13-09Z` pouze na
  `127.0.0.1:19111`;
- SHA-256 binárky:
  `af709e6ba68488404e85acdd22a3030d0f5e56a108d4b27d744f18ceb50861b4`;
- zdroj: `modvolt-phase11-source-test`, cíl:
  `modvolt-phase11-target-test`;
- 12 canary objektů, jeden pro každý chráněný prefix;
- snapshot: 12 objektů / 323 B plaintextu;
- verify: 12/12 payloadů autentizováno a hashově ověřeno;
- restore: 12/12 do odlišného bucketu;
- následné S3 porovnání: shodný seznam klíčů, SHA-256 a `Content-Type` 12/12;
- úklid: 0 temp S3 adresářů, port 19111 zavřený, žádný MinIO proces.

## 4. Toolchain nález a izolovaná oprava

Čistá Windows instalace odhalila, že `pnpm-workspace.yaml` vylučoval i aktuální
Windows x64 optional binárky Rollupu, esbuildu, Tailwind Oxide a Lightning CSS.
Vitest proto po čistém install nemohl načíst config. Čtyři aktuální platformní
výjimky byly odstraněny a lockfile doplnil pouze odpovídající binární balíčky ve
stávajících verzích.

Root `preinstall` navíc používal Unix-only `sh -c`. Byl nahrazen ekvivalentním
Node skriptem, který nadále fail-closed vyžaduje pnpm a odstraňuje konkurenční
`package-lock.json`/`yarn.lock`. Frozen instalace pak prošla včetně
supply-chain policy: 1099 entries.

## 5. Finální kontroly

| Kontrola | Výsledek |
| --- | --- |
| frozen install všech 12 workspaces | PASS; policy 1099 entries |
| všechny workspace typechecky | PASS |
| cílené object recovery unit testy | PASS, 5/5 |
| reálný S3 snapshot/verify/restore | PASS, 12/12 |
| frontend unit testy | PASS, 127/127 |
| live-events unit testy | PASS, 15/15 |
| API unit bez cizího stale frontend contract souboru | PASS, 285/285 |
| celý API unit strom | 290/291; jediný fail je níže popsaný cizí dirty-worktree kontrakt |
| API build | PASS; server + migration bundle |
| PWA build | PASS; Vite 7.3.5, 4015 modulů, 225 precache entries |
| ESLint | PASS |
| peer dependencies | PASS; 0 problémů |
| produkční dependency audit | PASS; 0 známých zranitelností |
| celý dependency audit | PASS pro Moderate+; 1 Low |
| `git diff --check` | PASS |
| úklid lokálního MinIO | PASS |

Standardní hermetický gate nebyl jako celek zelený kvůli již rozpracované
uživatelské frontend změně mimo FÁZI 11. `layout.tsx` rozšířil field navigation o
`/switchboards`, `/sklad` a `/stroje`, zatímco čistý
`field-job-workflow-contract.test.ts` stále očekává přesnou starou množinu čtyř
cest. Soubor testu ani frontend rozpracované změny nebyly v této fázi upraveny.
Před tímto jediným failem prošly všechny typechecky, env guard 5/5, frontend
127/127 a live-events 15/15; oba buildy byly následně spuštěny a prošly
samostatně v hermeticky očištěném prostředí.

## 6. Zbytková hranice R08

Implementační základ neprokazuje automatickou off-site/immutable produkční
kopii, retention/freshness monitoring, konkrétní RPO/RTO, dual control ani key
custody. Neřeší point-in-time konzistenci během souběžných zápisů a v1 bufferuje
jeden objekt v paměti. R08 proto není označen jako produkčně dokončený.

Lokální Codex `pnpm` wrapper se při použití temp virtual store pokoušel znovu
purgeovat `node_modules`; kontroly proto používaly přímo uzamčený pnpm 11.9.0.
Jde o lokální dispatch odchylku, nikoli změnu testovacího obsahu.
