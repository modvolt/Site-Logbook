# Checkpoint FÁZE 8.4 – druhý izolovaný řez R02

- **Stav:** FÁZE 8.4 dokončena; SEC-06 a SEC-10 jsou lokálně implementovány a ověřeny. R02 jako celek ani FÁZE 9 dokončeny nejsou.
- **Výchozí revize:** `cce68a7` (`main`; lokálně třináct commitů před `origin/main`).
- **Výsledná implementační revize:** `cf34a09` (`main`); dokumentační checkpoint je následující samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz`, externí object storage ani vzdálený Git; nic nebylo pushnuto ani nasazeno.
- **Migrace:** žádná. Vlastnictví objektů bylo možné odvodit z existujících přesných DB referencí.

## 1. Uzavřené nálezy a hranice řezu

1. **SEC-06:** trezor už nepropouští uživatele bez WebAuthn credentialu ani při DB chybě. Všechny plaintext read/export/distribution i create/update/delete operace vyžadují recentní, session-bound step-up. Ověření lze provést WebAuthn nebo aktuálním heslem.
2. **SEC-10:** generický `GET /api/storage/objects/*` už neslouží libovolný objekt pouze na základě znalosti cesty. Povolen je jen přesný existující odkaz z autoritativní doménové tabulky a uživatel musí mít všechna odpovídající view oprávnění.

Záměrně zůstává mimo rozsah:

- úplný manifest všech chráněných API rout s default-deny chováním, poslední otevřená část R02;
- produkční inventura historických objektových cest, rollout, monitoring a výkonové indexy;
- durable audit/outbox z R09/R12 a distribuovaný rate limiter pro více API instancí;
- jakýkoli další workstream nebo FÁZE 9.

## 2. Výsledná architektura trezoru

Middleware `requireVaultStepUp` přijímá pouze validní `vaultVerifiedAt` v aktuální session. Chybějící, nečíselný, budoucí nebo pět minut starý timestamp se odstraní a request skončí `403` s kompatibilním kódem `biometric_required`. Starší PWA klient proto stále otevře existující gate, ale odpověď nově uvádí podporu `webauthn` i `password`.

Úspěšný WebAuthn nebo nový rate-limitovaný `POST /api/auth/vault/verify-password` nejprve zapíše serverový audit `vault-step-up` a až potom nastaví pětiminutový session timestamp. Chybný password vrací generickou `401`; selhání auditu krok neodemkne. Password fallback používá aktuální bcrypt hash aktivního přihlášeného uživatele a nevytváří nový dlouhodobý credential.

Frontend používá jeden gate pro obě metody. Po expiraci během práce mutation neproběhne, data se znovu načtou a uživatel je vyzván k opětovnému ověření; aplikace citlivou mutaci automaticky neopakuje.

## 3. Výsledná architektura privátních objektů

Čistá prefixová policy nejprve odmítne prázdné, malformed, traversal-like, look-alike a neznámé cesty. Dedikované prefixy `backups`, `invoices`, `ppe-handovers` a `switchboards` generická route nikdy neslouží; zůstávají pouze na svých typovaných endpointech.

U ostatních prefixů DB resolver vyžaduje přesnou shodu celé object path:

| Prefix | Autoritativní reference | Vyžadované oprávnění |
|---|---|---|
| `cost-documents` | billing document, jeho file nebo email-import attachment | `billing.view` |
| `quotes` | `quotes.pdfObjectPath` | `quotes.view` |
| `customer-documents` | customer/site attachment URL | `customers.view` |
| `job-sheets` | job attachment URL | `jobs.view` |
| `job-signatures` | job signature object path | `jobs.view` |
| `ppe-signatures` | PPE assignment signature object path | `people.view` |
| `uploads` | job, activity nebo customer attachment URL | `jobs.view`, `activities.view` nebo `customers.view` |

Pokud stejný `uploads` klíč odkazuje více modulů, uživatel musí mít všechna jejich oprávnění. Nepropojený upload, reference uložená v nesprávné doménové tabulce, typed-only prefix, budoucí prefix i forbidden objekt vrací stejnou odpověď `404 Object not found`. DB chyba se zachytí jako serverová chyba a objekt se nevydá.

## 4. Logické commity a návrat

| Commit | Změna | Návrat |
|---|---|---|
| `96e5e96` | fail-closed vault step-up, password fallback, WebAuthn sjednocení, audit, frontend gate, OpenAPI/codegen a regresní testy | samostatný revert; bez změny schématu/dat, ale obnovil by původní fail-open stav SEC-06 |
| `cf34a09` | default-deny generický object download, přesné DB reference, doménová permission matice a DB/endpointové testy | samostatný revert; bez změny schématu/dat, ale obnovil by IDOR riziko SEC-10 |

Commity lze vracet nezávisle. Bezpečnější reakce na chybějící legitimní historickou cestu je doplnit přesnou klasifikaci a DB důkaz s testem; neobnovovat generický allow.

## 5. Provedené kontroly

### Cílené kontroly

- OpenAPI codegen pro React klienta a Zod schémata: prošel;
- API i frontend TypeScript typecheck: prošly;
- public-route a vault TTL kontrakty: 31/31;
- private-object prefix policy: 21/21;
- `git diff --check`: prošel.

### Izolovaný PostgreSQL 18

Jednorázový cluster běžel pouze na `127.0.0.1` v náhodném systémovém temp adresáři a portu. Ambientní `DATABASE_URL` byla odstraněna; runner vytvořil novou testovací DB, provedl migrace a nakonec DB, server i temp adresář odstranil.

- migration chain a forward → DOWN → forward: prošly;
- auth/session generation lifecycle: 4/4;
- vault DB/API matice: 6/6;
- private-object DB/API matice: 17/17;
- použitá session generation dál blokuje destruktivní rollback migrace `0096`.

Vault matice prokázala blokaci všech sedmi cest před step-up, neúspěšné heslo, úspěšný password fallback, serverový audit a izolaci druhé session. Object matice prokázala všech sedm DB-backed prefixů, tři vlastníky `uploads`, kombinované vlastnictví, wrong-domain referenci a jednotné endpointové 404.

### Hermetická release brána

Závěrečný `pnpm gate:release` nad `cf34a09` prošel bez DB a provider secretů:

- všechny TypeScript typechecky;
- test-environment guard 5/5;
- frontend 78/78;
- `live-events` 15/15;
- API unit/contract sada 24 souborů, 185/185;
- API production build;
- frontend production build, PWA a service worker.

Zůstala pouze známá neblokující Vite upozornění na chunky `index` přibližně 824 kB a HEIC přibližně 1,35 MB. Produkční smoke, DAST, vzdálené CI, migrace a nasazení spuštěny nebyly.

## 6. Nejasnosti a zbytková rizika

1. Před rolloutem je nutný pouze read-only soupis skutečných produkčních object paths. Nový default-deny záměrně odmítne historický prefix, který není v repozitáři nebo nemá současnou DB referenci; data nemažeme ani automaticky nepřemapováváme.
2. Přesná vyhledávání nad některými URL/object-path sloupci nemají vlastní index. Bez produkčního měření nebyla přidána migrace; je nutné sledovat download latency a případný index řešit samostatnou online změnou.
3. Pětiminutová expirace během editace může vyžadovat nové ověření. UI odmítnutou změnu samo nereplayuje, aby nemohla proběhnout po změně kontextu.
4. Password step-up rate limiter používá procesový store, tedy ve více instancích omezuje pokusy per-instance. Hesla musí zůstat silná; distribuovaný limiter a durable security events patří do provozních/auditních workstreamů.
5. Kompletní permission middleware stále obsahuje kompatibilní fallback pro necatalogované routy. Přechod na úplný default-deny bez route inventory by mohl legitimní interní workflow plošně uzamknout.

## 7. Jednoznačný checkpoint a doporučení pro další spuštění

**CHECKPOINT FÁZE 8.4:** lokální implementace SEC-06 a SEC-10 je dokončena a ověřena. R02 zůstává otevřené pouze kvůli úplnému default-deny manifestu chráněných rout. Nebyl proveden push, deploy, produkční test ani migrace. V tomto spuštění se nepokračuje do FÁZE 8.5 ani FÁZE 9.

- **další fáze:** FÁZE 8.5 – poslední izolovaný řez R02: úplný manifest chráněných rout a default-deny permission policy.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** je nutné zkřížit všechny registrované Express routy, HTTP metody, public/tokenové výjimky a permission overrides tak, aby nová nebo opomenutá route selhala zavřeně bez plošných legitimních `401/403`.
- **očekávané činnosti:** vygenerovat nebo staticky sestavit úplný method/path manifest; porovnat jej s registrací routerů a OpenAPI; určit permission pro každou chráněnou route; přidat default-deny a negativní role/override matici; navrhnout shadow inventory a rollback; spustit izolovanou DB sadu a plný release gate.
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/middlewares/public-api-policy.ts`, `artifacts/api-server/src/middlewares/permissions.ts`, nový route-manifest/policy modul, vybrané route moduly pouze při prokázané mezeře, OpenAPI a autorizační kontrakt/DB testy, `docs/audit/07-remediation-roadmap.md` a `docs/audit/08-phase-checkpoint.md`.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** databázová migrace se neočekává. Změna je však autorizačně vysoce riziková: chyba v manifestu může otevřít endpoint nebo způsobit rozsáhlé `401/403`; proto musí být rollout oddělený, měřitelný a vratný.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
