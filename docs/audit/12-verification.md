# FÁZE 12 – staging/R08 verification

## 1. Výsledek

FÁZE 12 uzavírá lokální implementační část objektového recovery gate:

- nové recovery bundle jsou streamované/chunkované schema v2;
- v1 zůstává ověřitelné a obnovitelné;
- source čtení je připnuté k S3 ETag/GCS generation;
- policy preflight je read-only a fail-closed podle explicitních požadavků;
- freshness autentizuje celý bundle;
- CI workflow obsahuje izolovaný MinIO large-object drill;
- reálný lokální MinIO drill obnovil 13/13 objektů.

Externí staging, off-site provider, immutable default retention, oddělené
credentials, key custody, alert delivery a schválené RPO/RTO nebyly dostupné.
R08 proto není označen jako produkčně dokončený a obecný release gate zůstává
zablokovaný.

Produkční DB, object storage, secrets, mail, `modvoltapp.cz`, deploy a remote
repository nebyly použity ani změněny. Nebyla přidána migrace ani backfill.

## 2. Implementace

### Recovery data plane

- `object-recovery.ts` zapisuje `modvolt-object-recovery/v2` po výchozích 8MiB
  blocích; každý blok má vlastní MVE1 AAD context a encrypted/plain SHA-256;
- manifest zůstává šifrovaný a autentizovaný odděleným backup keyringem;
- snapshot kontroluje inventurní délku a používá S3 `If-Match` nebo GCS
  generation; změna vede k failu a odstranění nedokončeného bundle;
- verify drží v paměti nejvýše jeden blok; restore před zápisem ověří celý
  bundle, streamuje bloky do providera a provede streamovaný read-back hash;
- v1 reader/restore zůstává kompatibilní, ale jeho historický jednokusový
  payload se při restore z principu bufferuje;
- endpoint s embedded userinfo je odmítnut dříve, než by se mohl propsat do
  secret-free identity nebo diagnostiky.

### Storage control plane

- S3 preflight čte dostupnost bucketu, TLS, versioning, Object Lock a default
  retenci, server-side encryption a public access block;
- GCS preflight čte bucket metadata, versioning, locked retention, default KMS
  a public access prevention;
- credential/API omezení vrací `unknown`; u vyžadované kontroly je `unknown`
  release fail;
- očekávaný storage fingerprint chrání proti omylem přepnutému targetu;
- preflight nikdy policy nenastavuje ani nemění.

### Operátorské a CI rozhraní

- CLI přidává `preflight`, `freshness` a volitelný `--chunk-bytes`;
- nový `objects:recovery:drill` má tvrdý `NODE_ENV=test`, explicitní potvrzení,
  pouze loopback endpoint, náhodné test buckety a úplný cleanup;
- lokální `.github/workflows/quality-gate.yml` po DB suites spouští pinovaný
  MinIO release, čeká na health, provede 64MiB+ recovery drill a server vždy
  zastaví.

## 3. Vzdálený CI stav

GitHub connector v read-only režimu zjistil:

- nejnovější commit default branch: `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- combined status: bez položek;
- PR-triggered workflow runs pro commit: bez položek;
- `.github/workflows/quality-gate.yml` na default branch: HTTP 404.

Lokální výchozí commit FÁZE 12 je `e9b05d7`. Vzdálená větev tedy neobsahuje ani
FÁZI 11, ani lokální quality/recovery gate. Nebyl proveden push ani vytvořen PR;
vzdálený CI run nelze vydávat za ověření této implementace.

## 4. Reálný izolovaný S3 drill

- MinIO community `RELEASE.2025-09-07T16-13-09Z` pouze na
  `127.0.0.1:19112`;
- ověřený SHA-256 Windows binárky:
  `af709e6ba68488404e85acdd22a3030d0f5e56a108d4b27d744f18ceb50861b4`;
- source/target byly rozdílné náhodné `phase12-test` buckety;
- oba buckety měly versioning a Object Lock capability;
- 12 chráněných prefixů + jeden 67 109 121B objekt;
- recovery chunk 8 388 608 B;
- snapshot 13, restore 13, read-back hash/size/type/metadata 13;
- source i target preflight `ready=true` pro lokální profil
  (access + loopback výjimka + versioning + Object Lock capability);
- lokální `recoveryPointAgeSeconds=0.604`;
- lokální celkový script baseline `recoveryTimeSeconds=2.233`;
- peak Node RSS 222 892 032 B;
- cleanup: porty 19112/19113 zavřené, 0 phase12 temp adresářů, oba versioned
  buckety i jejich historie odstraněné.

Lokální Object Lock bucket neměl default retention, aby jej bylo možné po testu
odstranit. Drill nepoužil oddělené credentials/account a neměří síť, reálný
objem, DB restore ani business smoke. Časy proto nejsou staging/produkční
RPO/RTO.

## 5. Závěrečné kontroly

| Kontrola                                      | Výsledek                                                  |
| --------------------------------------------- | --------------------------------------------------------- |
| všechny workspace typechecky                  | PASS, 4/4 artifact/script workspaces + library build      |
| cílené recovery unit testy                    | PASS, 10/10                                               |
| API unit strom                                | 295/296; jediný cizí field-navigation contract fail       |
| API unit bez cizího contractu                 | PASS, 290/290                                             |
| frontend unit testy v release gate            | PASS, 127/127                                             |
| live-events testy v release gate              | PASS, 15/15                                               |
| env safety guard                              | PASS, 5/5                                                 |
| izolovaný API DB strom                        | 137/138 souborů; jediný stejný cizí contract fail         |
| migrace jednorázové PostgreSQL 18 template DB | PASS, 103/103, latest `0102_immutable_job_quote_versions` |
| reálný S3 large-object drill                  | PASS, 13/13                                               |
| API build                                     | PASS                                                      |
| PWA build                                     | PASS, Vite 7.3.5, 4003 modulů, 225 precache entries       |
| `gate:quality`                                | PASS; lint, peers, audit od Moderate                      |
| dependency audit                              | 1 známý Low dev-only advisory, žádný Moderate+            |
| workflow YAML parse                           | PASS, 11 kroků                                            |
| Prettier phase scope                          | PASS                                                      |
| `git diff --check`                            | PASS                                                      |
| lokální PostgreSQL/MinIO cleanup              | PASS; porty 55442/19112/19113 zavřené, 0 temp adresářů    |

Celý `gate:release` není zelený jen kvůli existujícímu uživatelskému diffu:
`layout.tsx` povoluje field režimu `/switchboards`, `/sklad` a `/stroje`, zatímco
čistý `field-job-workflow-contract.test.ts` očekává přesnou starou čtveřici
`/`, `/calendar`, `/jobs`, `/me`. FÁZE 12 nezměnila ani jednu stranu tohoto
nesouladu.

## 6. Zbytkové blokátory

Autoritativní stav je v
[`12-staging-readiness-matrix.md`](12-staging-readiness-matrix.md). Kritické
blokátory jsou:

1. žádný externí staging/provider a bezpečné test identity;
2. žádný vzdálený CI run s lokálním workflow;
3. neschválená off-site topologie, default immutable retence a oddělené
   credentials;
4. neurčená key custody, dual control, cadence, alert owner a eskalace;
5. neschválené RPO/RTO;
6. chybějící společný staging DB + object recovery point a business smoke;
7. chybějící staging login/upload/download/sign/mail/PWA E2E;
8. cizí field-navigation contract není sladěn s rozpracovaným UX záměrem.

Lokální implementace je připravená k externí aktivaci, ale sama žádný z těchto
provozních závazků nedokazuje.
