# FÁZE 13 – runbook externí staging aktivace

Tento runbook aktivuje pouze oddělený staging. Není deployerem produkce a workflow
`staging-smoke.yml` samo nic nenasazuje. Vždy testuje již nasazený přesný commit a
zastaví se, pokud health endpoint vrátí jiný SHA.

## 1. Povinné vstupy a vlastnictví

V GitHub Environment `staging` nastavte protection reviewers a následující
hodnoty. Hodnoty secretů se nesmí zapisovat do repozitáře ani evidence JSON.

| Typ | Název | Kontrakt |
| --- | --- | --- |
| variable | `STAGING_BASE_URL` | čistý externí HTTPS origin; nikdy `modvoltapp.cz`, jeho subdoména ani localhost |
| variable | `STAGING_ENVIRONMENT_ID` | jednoznačný název s odděleným segmentem `staging`, `test`, `qa`, `sandbox` nebo `preview` |
| variable | `STAGING_MAIL_SANDBOX_CONFIRMED` | přesně `true`, pouze pokud žádný staging e-mail nemůže dojít skutečnému zákazníkovi |
| secret | `STAGING_ADMIN_USERNAME` | dedikovaná staging identita s `diagnostics.view`; nesdílet s produkcí |
| secret | `STAGING_ADMIN_PASSWORD` | unikátní staging heslo alespoň 16 znaků; nesdílet s produkcí |

Dále musí být známé, ale neukládají se do GitHub workflow:

- oddělená staging DB a prázdný recovery bucket s ověřeným fingerprintem;
- source/off-site storage profily a vlastníci recovery klíčů;
- mail sandbox inbox a příjemce;
- schválené RPO/RTO a jmenovaní service owner, operator a nezávislý reviewer;
- anonymizovaný společný recovery point DB + objektů.

## 2. Abort hranice před nasazením

Okamžitě zastavte běh, pokud platí alespoň jedno:

- URL, DB, bucket, mail recipient nebo credential patří produkci;
- staging má síťovou cestu, IAM oprávnění nebo sdílený secret umožňující změnu produkce;
- není doložena anonymizace recovery pointu;
- target bucket není prázdný/oddělený nebo jeho fingerprint není schválený;
- nelze potvrdit versioning, immutable retention a read-only policy preflight;
- nasazené `/api/healthz.version` není přesně commit testovaného workflow;
- chybí druhý člověk pro review nebo schválené RPO/RTO.

## 3. Publikace a nasazení přesného commitu

1. V čistém review ověřte celý lokální commit rozsah; tato větev byla při FÁZI 13
   desítky commitů před remote a obsahovala cizí rozpracované UI změny.
2. Push/pull request proveďte pouze po samostatném výslovném schválení uživatele.
3. Vyčkejte na zelený `Quality gate` pro přesný plný SHA.
4. Nasazujte stejný SHA do izolovaného stagingu; nastavte API `BUILD_SHA` a frontend
   `VITE_BUILD_SHA` na plný SHA.
5. Počítejte s tím, že API image při startu automaticky aplikuje existující
   migrace. Cílová DB proto musí být stagingová a předem obnovitelná.

## 4. Ruční staging smoke

V GitHub Actions spusťte `Staging smoke (manual, no deploy)` na právě nasazeném
ref. Zaškrtněte obě potvrzení pouze po kontrole targetu. Workflow:

1. fail-closed ověří URL, identitu, mail sandbox a plný SHA bez výpisu secretů;
2. ověří veřejnou DB/migrační readiness;
3. vytvoří staging session dedikované identity;
4. zavolá `/api/admin/health`, který provede malou write/delete storage sondu;
5. ověří storage bez dev fallbacku, SMTP konfiguraci, PWA manifest a service worker;
6. otevře autentizovaný shell v desktopním Chromium a emulovaném iPhone 13;
7. uloží pouze secret-free bootstrap summary na 14 dní.

Chybějící proměnná, `admin/admin`, HTTP, lokální/produkční host, krátký SHA nebo
nepotvrzená storage sonda ukončí workflow před přihlášením.

## 5. Společný DB + object recovery drill

Použijte [runbook FÁZE 12](12-object-recovery-runbook.md), ale pouze nad novou
staging DB a novým bucketem. Držte jeden `sourceCreatedAt` pro DB i object bundle.

Povinné důkazy:

- DB restore dokončen, migrace v paritě a business smoke prošel;
- očekávaný a obnovený počet objektů je shodný a nenulový;
- hash, content type a metadata objektů souhlasí;
- target je oddělený, versionovaný a má schválenou immutable retenci;
- skutečné RPO a RTO nepřekračují schválené hodnoty;
- freshness monitor vyvolá a doručí testovací alert;
- anonymizovaná data neopustí schválené staging hranice.

## 6. Business a mail evidence

Použijte pouze disposable staging fixtures s jednoznačným prefixem run ID.
Ověřte login/role, upload a následný download stejného hashe, podpisový tok,
business čtení po restore, offline/PWA assety a doručení výhradně do sandboxu.
Automatické lokální E2E ze stávající `e2e/playwright.config.ts` zde nepoužívejte:
má localhost fallback a historický setup `admin/admin`.

Po běhu buď fixtures smažte, nebo zaznamenejte schválenou dobu uchování. Mazání
immutable objektů nemusí být možné před koncem retence; tuto retenci nezapínejte
bez schválení vlastníka nákladů a lifecycle.

## 7. Finální evidence gate

1. Zkopírujte `13-staging-evidence.template.json` mimo sledovaný repozitář.
2. Nahraďte všechny `PENDING` hodnoty a přiložte odkazy na zdrojové artefakty v
   externím ticketu/run logu; do JSON nevkládejte secret, token, credential ani URL
   s userinfo.
3. Spusťte:

   ```text
   pnpm gate:staging-evidence -- --file <absolute-path-to-evidence.json>
   ```

Gate přijme pouze čerstvý (výchozí limit 48 hodin), plně zelený, dvoučlenně
schválený záznam. `decision: PASS` je nutná, nikoli sama dostačující podmínka
produkčního release. Produkce vyžaduje nový samostatný souhlas.

## 8. Rollback a cleanup

- Smoke workflow nic nenasazuje; při failu pouze ukončete run a zneplatněte jeho
  staging session/fixtures.
- Při chybě deploye vraťte staging na poslední známý staging SHA, nikoli na
  produkční resource.
- Při recovery failu zachovejte logy/manifests bez secretů, nový target označte
  jako failed a neopakujte restore do téhož neurčitého bucketu.
- Ověřte, že mail sandbox nezanechal skutečnou delivery route a že žádný testovací
  bearer link nebyl publikován.
