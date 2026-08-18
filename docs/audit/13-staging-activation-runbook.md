# FÁZE 13 – runbook externí staging aktivace

Tento runbook aktivuje pouze oddělený staging. Není deployerem produkce a workflow
`staging-smoke.yml` samo nic nenasazuje. Vždy testuje již nasazený přesný commit a
zastaví se, pokud health endpoint vrátí jiný SHA.

## 1. Povinné vstupy a vlastnictví

V GitHub Environment `staging` nastavte branch restriction a následující hodnoty.
V běžném `dual_control` režimu přidejte protection reviewera. Pokud projekt nemá
druhého člověka, je povolen pouze explicitní `solo_maintainer` režim: reviewer je
`null`, vlastník přijme riziko a evidence doloží chráněný `main`, povinný exact-SHA
Quality gate a branch-restricted Environment. AI kontrola se neeviduje jako nezávislý
lidský reviewer. Hodnoty secretů se nesmí zapisovat do repozitáře ani evidence JSON.

| Typ      | Název                                  | Kontrakt                                                                                                                  |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| variable | `STAGING_BASE_URL`                     | čistý externí HTTPS origin; nikdy `modvoltapp.cz`, jeho subdoména ani localhost                                           |
| variable | `STAGING_ENVIRONMENT_ID`               | přesně logické runtime ID `site-logbook-staging`; opaque Coolify environment ID je samostatné pole deployment artefaktu   |
| variable | `STAGING_MAIL_SANDBOX_CONFIRMED`       | přesně `true`, pouze pokud žádný staging e-mail nemůže dojít skutečnému zákazníkovi                                       |
| variable | `STAGING_ALERT_RECEIVER_URL`           | samostatný veřejný HTTPS endpoint končící přesně `/v1/operational-alerts`; hostname se nesmí shodovat se staging aplikací |
| variable | `STAGING_EXTERNAL_ACCOUNTS_ENABLED`    | přesně `false`; změna flagu je až samostatná pilotní fáze                                                                 |
| variable | `STAGING_IMAGE_MANIFEST_SHA256`        | 64 malých hex znaků, přesně schválený SHA-256 raw `staging-images.json`                                                   |
| variable | `STAGING_PROVISIONING_MANIFEST_SHA256` | 64 malých hex znaků, SHA-256 validovaného observed provisioning artefaktu                                                 |
| variable | `STAGING_DEPLOYMENT_INPUTS_SHA256`     | 64 malých hex znaků, hash právě aktivního kanonického inspect/transition/steady vstupu                                    |
| secret   | `STAGING_ADMIN_USERNAME`               | dedikovaná staging identita s `diagnostics.view` i `users.manage`; nesdílet s produkcí                                    |
| secret   | `STAGING_ADMIN_PASSWORD`               | unikátní staging heslo alespoň 16 znaků; nesdílet s produkcí                                                              |
| secret   | `STAGING_ALERT_RECEIVER_BEARER_TOKEN`  | náhodná base64url hodnota z alespoň 32 bajtů, uložená pouze v GitHub Environment a secret manageru receiveru              |

Dále musí být známé, ale neukládají se do GitHub workflow:

- oddělená staging DB a prázdný recovery bucket s ověřeným fingerprintem;
- source/off-site storage profily a vlastníci recovery klíčů;
- mail sandbox inbox a příjemce;
- schválené RPO/RTO a jmenovaní service owner a operator; v `dual_control` režimu
  také nezávislý reviewer, v `solo_maintainer` režimu explicitní owner waiver;
- schválený společný recovery point DB + objektů klasifikovaný přesně jako
  `production-copy-restricted`, s oddělenými staging credentials, omezeným přístupem,
  dobou uchování a plánem bezpečného odstranění.

## 2. Abort hranice před nasazením

Okamžitě zastavte běh, pokud platí alespoň jedno:

- URL, DB, bucket, mail recipient nebo credential patří produkci;
- staging má síťovou cestu, IAM oprávnění nebo sdílený secret umožňující změnu produkce;
- recovery point není evidovaný jako `production-copy-restricted` nebo nejsou
  schválené jeho přístupové, retenční a cleanup hranice;
- target bucket není prázdný/oddělený nebo jeho fingerprint není schválený;
- nelze potvrdit versioning, immutable retention a read-only policy preflight;
- nasazené `/api/healthz.version` není přesně commit testovaného workflow;
- chybí druhý člověk v `dual_control` režimu nebo povinné kompenzační kontroly a
  owner waiver v `solo_maintainer` režimu; případně chybí schválené RPO/RTO.

## 3. Publikace a nasazení přesného commitu

1. V čistém review ověřte celý lokální commit rozsah; tato větev byla při FÁZI 13
   desítky commitů před remote a obsahovala cizí rozpracované UI změny.
2. Push/pull request proveďte pouze po samostatném výslovném schválení uživatele.
3. Vyčkejte na zelený `Quality gate` pro přesný plný SHA.
4. Nasazujte stejný SHA do izolovaného stagingu; nastavte API `BUILD_SHA`, frontend
   `VITE_BUILD_SHA` a receiver `RECEIVER_BUILD_SHA` na plný SHA. Použijte pouze
   digest-pinned privátní image z manifestu schváleného publisher workflow.
5. API image při běžném startu žádnou migraci automaticky nespouští. API čeká na
   úspěšný one-shot `external-schema-gate` a před startem serveru provede ještě
   read-only steady-state kontrolu. Standardní migrátor smí spustit pouze samostatně
   schválený režim `apply-0105`; cílová DB proto musí být stagingová a předem
   obnovitelná.
6. Receiver provozujte za veřejným TLS proxy, s vlastním hostname, persistentním
   volume a platformními log alerty. Jeho volume ani logy nesmí sdílet API proces.

### 3A. Exact-0104 recovery point a kanonický přechod

Po baseline na exact `0104` nesmí kvůli vytvoření zálohy startovat běžné API.
Po samostatném souhlasu spusťte pouze profile-only one-shot; jako jediná jiná
běžící služba musí zůstat `postgres`:

```powershell
pnpm staging:create-exact-0104-backup -- --env-file .env.staging --compose-file docker-compose.staging.yml --expected-source-sha <40-hex> --baseline-execution <baseline-execution-dir>\staging-baseline-0104-execution.json --baseline-execution-checksum <baseline-execution-dir>\staging-baseline-0104-execution.sha256 --expected-baseline-execution-sha256 <64-hex> --inspect-inputs <initial-binding-dir>\staging-deployment-inspect.json --inspect-inputs-checksum <initial-binding-dir>\staging-deployment-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --confirm CREATE_FRESH_EXACT_0104_STAGING_BACKUP_AND_RESTORE_TEST --output-dir <backup-execution-dir>
```

Recovery binding musí převzít přesné bajty a samostatně schválený checksum
`<backup-execution-dir>\staging-exact-0104-backup-execution.json`; nové backup ID
se nesmí ručně přepsat. Binding tak zachová source execution SHA, 256 MiB strop a
skutečnou velikost. Před read-only recovery runnerem instalujte přesné hodnoty z
vygenerovaného `staging-exact-0104-recovery-environment.json` do `.env.staging`.
Binding z přesných původních inspect bajtů odvodí nový
`staging-exact-0104-recovery-inspect.json`: změní pouze backup ID a schválený
restore max-age, přepočítá checksum a stejný nový hash vloží do recovery
environmentu. Ruční přepis ID nebo opětovné použití starého inspect checksumu je
zakázané.

Tyto dva kroky jsou povinné a nesmějí se nahradit ručním backup ID ani holým
`docker compose run`:

```powershell
pnpm gate:staging-exact-0104-recovery-binding -- --baseline-inputs <baseline-binding-dir>\staging-baseline-0104-inputs.json --baseline-inputs-checksum <baseline-binding-dir>\staging-baseline-0104-inputs.sha256 --expected-baseline-inputs-sha256 <64-hex> --baseline-execution <baseline-execution-dir>\staging-baseline-0104-execution.json --baseline-execution-checksum <baseline-execution-dir>\staging-baseline-0104-execution.sha256 --expected-baseline-execution-sha256 <64-hex> --backup-execution <backup-execution-dir>\staging-exact-0104-backup-execution.json --backup-execution-checksum <backup-execution-dir>\staging-exact-0104-backup-execution.sha256 --expected-backup-execution-sha256 <64-hex> --inspect-inputs <initial-binding-dir>\staging-deployment-inspect.json --inspect-inputs-checksum <initial-binding-dir>\staging-deployment-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --backup-restore-max-age-hours 24 --output-dir <recovery-binding-dir>
```

Po kontrole a instalaci hodnot z
`<recovery-binding-dir>\staging-exact-0104-recovery-environment.json`:

```powershell
pnpm staging:verify-exact-0104-recovery -- --env-file .env.staging --compose-file docker-compose.staging.yml --expected-source-sha <40-hex> --expected-inputs-sha256 <64-hex> --inspect-inputs <recovery-binding-dir>\staging-exact-0104-recovery-inspect.json --inspect-inputs-checksum <recovery-binding-dir>\staging-exact-0104-recovery-inspect.sha256 --expected-inspect-inputs-sha256 <64-hex> --output-dir <recovery-execution-dir>
```

Detailní fail-closed kontrakt a pořadí kontrol jsou závazně popsány v
`docs/audit/16-c3-staging-schema-gate-runbook.md`; tento aktivní runbook je
nezkracuje ani neobchází.

One-shot před zápisem sváže kanonické inspect inputs se skutečně resolved Compose
projektem, exact API digestem, staging DB identitou a schváleným S3 targetem.
Opaque Coolify environment ID zůstává oddělené od logického runtime ID
`site-logbook-staging`. Potom vytvoří právě jednu novou `mve1` zálohu, vypne retenční promazávání a
restore-testuje stejné nové ID do dočasné DB. Výsledek neautorizuje `0105`.
One-shot používá pevný 256 MiB payload limit a 512 MiB `/tmp` tmpfs; překročení
dumpu nebo uloženého payloadu je fail-closed stop před jakoukoli migrací.
Exact bindingem převzaté ID použije read-only recovery runner bez ruční změny.
Z ověřeného recovery výsledku poté znovu spusťte
`gate:staging-deployment-binding` do nového prázdného adresáře s tímto novým ID;
původní inspect/transition/steady artefakty svázané se starým ID jsou neplatné.
Zaznamenejte absolutní cestu nového binding adresáře a recovery execution
adresáře. V novém `staging-deployment-environment.json` zkontrolujte blok
`transition` a instalujte jeho přesné hodnoty do `.env.staging`; starší inspect
nebo transition hodnoty se nesmí znovu použít.

Teprve po dalším výslovném souhlasu spusťte přechod přes host runner, nikoli
holým `docker compose run`:

```powershell
pnpm staging:apply-0105-transition -- --env-file .env.staging --compose-file docker-compose.staging.yml --expected-source-sha <40-hex> --transition-inputs <new-binding-dir>\staging-deployment-transition.json --transition-inputs-checksum <new-binding-dir>\staging-deployment-transition.sha256 --expected-transition-inputs-sha256 <64-hex> --recovery-execution <recovery-execution-dir>\staging-exact-0104-recovery-execution.json --recovery-execution-checksum <recovery-execution-dir>\staging-exact-0104-recovery-execution.sha256 --expected-recovery-execution-sha256 <64-hex> --confirm APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING --output-dir staging-schema-transition
```

Runner před migrací uloží checksumově svázaný intent pouze po živém
`READY_0104`. Z jediného post-migration DB snapshotu pak atomicky zpřístupní
`final/staging-schema-gate.json`, `final/staging-backup-evidence.json` a oba
checksumy. Když host po úspěšné migraci skončí před finalizací, další běh smí
přijmout `ALREADY_0105` pouze s již existujícím shodným intentem; první no-op bez
předchozího intentu je stop. Recovery no-op znovu provede plný post-preflight a
oba finální artefakty vytvoří z jednoho nového repeatable-read snapshotu; nesmí
zkopírovat starší backup age z recovery artefaktu.
Před intentem runner také ověří resolved Compose project, exact API digest,
staging DB identitu a source/input hashe proti transition artefaktu. Databázový
migrátor serializuje samotné aplikování migrací: proces s `newlyApplied=1` vrátí
`APPLIED`, souběžný proces s `newlyApplied=0` vrátí `NOOP`. První NOOP se
nepovažuje za úspěch; finalizace je možná jen opakováním se stejným již uloženým
reviewovaným intentem.

## 4. Ruční staging smoke

V GitHub Actions spusťte `Staging smoke (manual, no deploy)` na právě nasazeném
ref. Zaškrtněte všechna tři potvrzení pouze po kontrole targetu. Workflow:

1. fail-closed ověří URL, identitu, mail sandbox a plný SHA bez výpisu secretů;
2. ověří veřejnou DB/migrační readiness;
3. vytvoří staging session dedikované identity;
4. zavolá `/api/admin/health`, který provede malou write/delete storage sondu;
5. ověří storage bez dev fallbacku, SMTP konfiguraci, PWA manifest a service worker;
6. otevře autentizovaný shell v desktopním Chromium a emulovaném iPhone 13;
7. ověří exact-SHA health receiveru, pošle jeden redigovaný syntetický event a
   opakováním stejného idempotency key prokáže persistentní deduplikaci;
8. uloží pouze secret-free bootstrap a alert summary na 14 dní.

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
- skutečný staging incident projde durable outboxem do receiveru a je potvrzen;
- přímý syntetický event je po restartu receiveru stále deduplikován díky volume;
- bezpečně vyvolaný výpadek staging health endpointu vytvoří v platformních
  receiver logách `dead_man_triggered` a obnovení vytvoří `dead_man_recovered`;
- data `production-copy-restricted` neopustí schválené staging hranice a žádný
  mail, externí účet ani integrační webhook nevede ke skutečnému zákazníkovi.

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
2. Nahraďte všechny `PENDING` hodnoty a uchovejte všech osm raw zdrojových artefaktů
   vedle výsledné evidence. Odkazy v externím ticketu/run logu samotné nestačí; do
   JSON nevkládejte secret, token, credential ani URL s userinfo.
3. Spusťte schema-v4 gate nad výslednou evidencí i všemi osmi raw artefakty:

   ```text
   pnpm gate:staging-evidence -- --file staging-release-evidence.json --image-manifest staging-images.json --inspect-inputs staging-deployment-inspect.json --transition-inputs staging-deployment-transition.json --steady-inputs staging-deployment-steady.json --schema-gate-evidence staging-schema-gate.json --backup-evidence staging-backup-evidence.json --provisioning staging-provisioning-observed.json --bootstrap staging-bootstrap-summary.json
   ```

Gate přijme pouze čerstvý (výchozí limit 48 hodin) a plně zelený záznam. Výchozí
`dual_control` vyžaduje rozdílného operatora a reviewera. Výslovně zvolený
`solo_maintainer` místo toho vyžaduje `reviewer: null`, přijetí rizika vlastníkem a
všechny tři kompenzační kontroly. `decision: PASS` je nutná, nikoli sama dostačující
podmínka produkčního release. Produkce vyžaduje nový samostatný souhlas.

Schéma evidence verze 4 odděluje přímý receiver smoke od skutečného durable outbox
doručení a dead-man fault drillu. Automatický smoke tedy sám o sobě nestačí k
vyplnění všech položek `alerts` hodnotou `pass`.

## 8. Rollback a cleanup

- Smoke workflow nic nenasazuje; při failu pouze ukončete run a zneplatněte jeho
  staging session/fixtures.
- Při chybě deploye vraťte staging na poslední známý staging SHA, nikoli na
  produkční resource.
- Při recovery failu zachovejte logy/manifests bez secretů, nový target označte
  jako failed a neopakujte restore do téhož neurčitého bucketu.
- Ověřte, že mail sandbox nezanechal skutečnou delivery route a že žádný testovací
  bearer link nebyl publikován.
