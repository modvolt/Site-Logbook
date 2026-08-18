# R16-C1 – ověření veřejného Bearer transportu

Datum: 2026-08-05

## Rozsah

R16-C1 dokončuje compatibility expand pro veřejné podpisové, OOPP, nabídkové a
QR workflow. Nové odkazy předávají credential v URL fragmentu, frontend jej
jednorázově zachytí do paměti a API používá `Authorization: Bearer`. Původní
veřejné routy zůstávají dočasně kompatibilní, aby se nezneplatnily již odeslané
odkazy ani vytištěné QR štítky.

Jde pouze o změny repozitáře a draft PR. Nebyl proveden merge, deployment,
build/push image, změna Coolify, DNS, secrets, stagingu, produkce, databáze ani
objektového úložiště. Nevznikla ani nebyla aplikována žádná migrace; `0100`
zůstává nezařazená a připravené `0103`/`0104` zůstávají neaplikované.

Přihlášené externí účty nejsou součástí R16-C1. Role `guest` nadále není
považována za bezpečný externí account model.

## Kanonický veřejný kontrakt

Kanonické API již nenese token v cestě, query ani body:

| Účel | Kanonické API | Metody |
| --- | --- | --- |
| podpis zakázky | `/api/sign` | `GET`, `POST` |
| podpis OOPP | `/api/ppe/sign` | `GET`, `POST` |
| potvrzení OOPP | `/api/ppe/confirm` | `GET`, `POST` |
| rozhodnutí o nabídce | `/api/quotes/public` | `GET` |
| přijetí/odmítnutí nabídky | `/api/quotes/public/accept`, `/api/quotes/public/reject` | `POST` |
| veřejný rozvaděč | `/api/q/board` | `GET` |
| dokument rozvaděče | `/api/q/board/documents/:sha256` | `GET` |

Strict parser přijme právě jednu hlavičku ve tvaru `Bearer <token>`. Chybějící
nebo malformed credential vrací `401`, `WWW-Authenticate: Bearer` a stabilní
kód `public_bearer_required`. Současný Bearer a legacy credential nebo duplicitní
Authorization vrací `400` s `ambiguous_public_credential`. Odpověď nikdy
neodráží token.

Legacy endpointy a deprecated query/body token OOPP potvrzení zůstávají čitelné,
ale současné použití Authorization odmítnou. Tím je přechod zpětně kompatibilní
a současně nevzniká nejednoznačné pořadí credentialů.

OpenAPI obsahuje `publicBearer`, kanonické operace a deprecated legacy varianty.
Veřejné grant operace nejsou generovány do běžného React query klienta, aby se
credential nemohl dostat do query keys, URL nebo perzistentní cache. Generované
Zod kontrakty zůstávají dostupné pro validaci.

## Browser a PWA hranice

- nové producer URL používají `#token=...`; fragment se neposílá serveru ani
  reverzní proxy;
- bootstrap token jednorázově zachytí do module-memory a URL okamžitě vyčistí
  přes `history.replaceState`;
- aktivní grant je vázán na přesný purpose a routu a při jakékoli změně routy se
  synchronně zahodí;
- druhý grant otevřený ve stejném tabu vyvolá před scrubnutím reload, takže data
  a následná mutace patří atomicky novému grantu;
- veřejný fetch dovolí pouze stejný origin a přesnou kombinaci purpose,
  kanonické API rodiny a HTTP metody; odmítne username/password, query, fragment,
  redirect i legacy API URL;
- request používá `credentials: omit`, `cache: no-store`, `Referrer-Policy:
  no-referrer`, `mode: same-origin` a jedinou Bearer hlavičku;
- service worker veřejné grant API vždy obchází network-only před identity cache;
  veřejné stránky jsou `noindex` a update prompt PWA se na nich nezobrazuje;
- dokument rozvaděče se stáhne Bearer fetchem do dočasného blob URL a po použití
  se bezpečně uvolní.

## Server, proxy a rate limiting

Centrální route policy klasifikuje veřejné grant routy ještě před body parserem.
Read operace mají limit 120 požadavků za 15 minut, mutace 30 za 15 minut. Klíč
je kombinace validované klientské IP a rodiny IP; IPv6 se nepřevádí na kolizní
řetězec.

Produkční API nyní fail-closed vyžaduje `API_TRUSTED_PROXY_CIDRS`. Přijme pouze
explicitní IP nebo nenulový CIDR; odmítne hop count, broad alias, `/0`, prázdné
položky, neplatné oktety i nepodporovanou syntaxi. Test/local výchozí hodnota je
pouze loopback. Staging preflight používá stejný záměr a má spustitelné pozitivní
i negativní kontrakty.

WebAuthn RP ID a origin se v produkci odvozují výhradně z validovaného
`PUBLIC_APP_URL`, nikoli z `Host` nebo `X-Forwarded-Proto`. Tím podvržené
forwarded hlavičky nemění WebAuthn bezpečnostní hranici.

## Ověření

### Lokálně bez Dockeru a databáze

- celý `pnpm.cmd run gate:release`: PASS;
- TypeScript: PASS;
- 35/35 script kontraktů, 160/160 frontend testů, 15/15 live-events testů a
  539/539 API unit/contract testů: PASS;
- API build a produkční Vite/PWA build: PASS;
- root ESLint, E2E TypeScript a `git diff --check`: PASS;
- deterministický manifest: 420 rout;
- OpenAPI: 275 paths, 361 unikátních operation IDs a úplné 400 pokrytí
  ambiguity/validation veřejných operací: PASS;
- staging proxy preflight: pozitivní případy i 11 neplatných konfigurací: PASS;
- staging runtime kontrakt: 2,5 CPU, 2432 MiB a immutable private GHCR/no-deploy:
  PASS.

Úplný lokální staging workflow zůstal 38/47: devět kroků vyžadovalo chybějící
offline Docker workflow-harness image. Image nebyla kvůli stabilitě počítače
stahována; tyto kroky následně provedl GitHub runner.

### GitHub exact-SHA

Draft PR [#13](https://github.com/modvolt/Site-Logbook/pull/13) míří z
`agent/phase16c-public-bearer-expand` do `agent/phase16b-external-grants`.

První [Quality gate 30979343171](https://github.com/modvolt/Site-Logbook/actions/runs/30979343171)
na implementačním commitu `6cd6920f8bc162f9ea2c7f130c4161cf67611a30`
odhalil pět zastaralých DB testových očekávání. Testy stále čekaly `400` pro
missing/malformed OOPP confirmation credential, zatímco nový OpenAPI a Bearer
kontrakt správně vrací `401`. Produkční logika se neměnila; test-only commit
`c7151cb31dfee4aec329ac464e73febf37e18470` doplnil také kontrolu
`WWW-Authenticate: Bearer` a `public_bearer_required`.

Na přesném SHA `c7151cb31dfee4aec329ac464e73febf37e18470` prošel
[Quality gate 30980066883](https://github.com/modvolt/Site-Logbook/actions/runs/30980066883):

- quality a celý hermetický release gate: PASS;
- immutable staging runtime a staging workflow kontrakty: PASS;
- všech 174 izolovaných API DB souborů po aplikaci 104/104 migrací: PASS;
- izolovaný šifrovaný backup/restore a concurrency gate: PASS;
- encrypted streaming object-recovery drill: PASS;
- R14 isolated full-stack/fault gate: PASS.

## Povinné podmínky před stagingem

Repo-level zelený PR není souhlas s nasazením. Před prvním staging deployem je
nutné:

1. read-only zjistit přesné CIDR nginx/Traefik proxy, které skutečně vidí API;
2. nastavit `API_TRUSTED_PROXY_CIDRS` před startem nové verze, nikdy `/0`, alias
   nebo odhadovaný hop count;
3. potvrdit, že Traefik sanitizuje forwarded hlavičky a nemá
   `forwardedHeaders.insecure=true`;
4. znemožnit přímý veřejný bypass API mimo schválený proxy řetězec;
5. na stagingu ověřit `req.ip`, oddělení klientských rate-limit klíčů,
   `X-Forwarded-Proto` a Secure session cookie;
6. v reálném browseru a redigovaných inner/outer proxy logách prokázat, že nové
   odkazy neposílají raw token v request URL, Referer ani cache;
7. před contract odstraněním legacy rout provést inventuru a případný řízený
   přetisk fyzických QR štítků.

## Zbytkové hranice

- legacy veřejné URL zůstávají záměrně přijímány; jejich odstranění patří až do
  samostatného contract release po inventuře skutečných odkazů a QR;
- outer Coolify/Traefik logy a živá proxy topologie nebyly v této repo fázi
  ověřeny;
- přihlášené externí účty dosud nemají deny-by-default account type, resource
  scopes, expiraci na každém requestu/list query, interního custodiana ani
  atomický transfer při offboardingu;
- single-organization datový model stále není tenant isolation;
- žádná připravená databázová migrace nebyla touto fází autorizována k aplikaci.
