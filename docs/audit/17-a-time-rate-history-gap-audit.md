# R17-A – audit historie času, sazeb, cen a korekcí

Datum: 2026-08-11  
Stav: **NOT READY / implementace R17 ještě není uzavřena**  
Rozsah tohoto checkpointu: pouze statický audit a návrh další hranice; bez deploye, spuštění migrace, GHCR zápisu a změny produkčních dat.

## Výsledek

Repozitář už obsahuje podstatnou část zamýšleného modelu R17:

- effective-dated hodinové sazby s důvodem, autorem a void historií;
- pracovní session, append-only eventy a kladné i záporné korekční session;
- snapshot nákladové a prodejní sazby na pracovní session;
- snapshot délky, prodejní sazby a částky v billing vazbě;
- blokaci fakturace session bez sazby nebo ve stavu `needs_review`;
- oddělení vlastního timeru pracovníka od správy cizího času.

Tento základ ale zatím nesplňuje celý exit kontrakt R17. OpenAPI označuje work sessions jako immutable, zatímco některé provozní cesty stále mění jejich finanční nebo revizní stav bez úplného korekčního důkazu.

## Registr nálezů

### R17-A-01 – existující snapshot lze přecenit novou sazbou

**Závažnost:** P1 blocker  
**Důkaz:** `createHourlyRate()` po vložení sazby aktualizuje `hourlyRateId`, `costRateSnapshot` a `saleRateSnapshot` u všech odpovídajících session se stavem `billingStatus = unbilled`. Podmínka neomezuje změnu na dosud neznámé (`NULL`) snapshoty.

**Dopad:** zpětně vložená sazba může změnit již známou minulou cenu před vytvořením draftu. To odporuje cíli R17, že minulost nelze přepočítat novou sazbou a vydaný podklad je rekonstruovatelný z tehdy zachycených hodnot.

**Požadovaná hranice:** existující nenulový snapshot je immutable. Případný backfill `NULL` hodnot smí vzniknout jen z doložené effective-dated sazby, s explicitním eventem, důvodem a aktérem.

### R17-A-02 – chybí source timezone/clock

**Závažnost:** P1 blocker  
**Důkaz:** work session ukládá `started_at`/`ended_at` jako PostgreSQL `timestamp` bez časové zóny. Manuální API přijímá pouze výsledný `date-time`; neukládá původní offset, IANA timezone ani původ hodin. Timer používá serverové `new Date()`. Výběr sazby převádí okamžik přes `toISOString().slice(0, 10)`, tedy podle UTC kalendářního dne.

**Dopad:** u práce kolem půlnoci nebo změny letního času nelze doložit původní lokální čas. Sazba platná podle lokálního pracovního dne může být vybrána podle jiného UTC dne.

**Požadovaná hranice:** nové záznamy musí nést přesný instant, zdroj hodin (`server`/`client`), IANA timezone a původní UTC offset. Historické záznamy bez doloženého zdroje musí být označeny `legacy_unknown`; nesmí se jim domýšlet timezone.

### R17-A-03 – stav `needs_review` nelze řádně schválit

**Závažnost:** P1 funkční blocker  
**Důkaz:** schema dovoluje `review_status = approved` a fakturace odmítá `needs_review`, ale v service, routách, OpenAPI ani UI není operace approve/reject. Seznam session pouze automaticky nastavuje další `needs_review` a zapisuje `review_flagged`.

**Dopad:** dlouhá nebo podezřelá session může zůstat trvale nefakturovatelná; schválení by dnes vyžadovalo přímý zásah do DB bez aplikačního eventu.

**Požadovaná hranice:** manager-only approve/reject operace s povinným důvodem, aktérem, časem a append-only eventem. Pracovník smí ovládat pouze svůj přiřazený timer; nesmí schvalovat vlastní ani cizí revizní záznam.

### R17-A-04 – void a agregovaná korekce nemají úplnou provenienci

**Závažnost:** P1 blocker  
**Důkaz:** DELETE work-session nemá request body s důvodem a zapisuje pouze hard-coded `manual_void`. Odstranění time trackingu používá hard-coded `time_tracking_removed`. `setManualWorkTotal()` vytváří korekční session s důvodem, ale s časem `now`, sazbou platnou nyní a bez vazby na konkrétní původní session nebo explicitní historické období.

**Dopad:** nelze spolehlivě určit, kterou původní skutečnost korekce opravuje a podle kterého tehdy platného dne má být oceněna. Korekce může nechtěně použít současnou sazbu.

**Požadovaná hranice:** void musí vyžadovat lidský důvod. Korekce musí odkazovat na původní session nebo na explicitně vymezené období/effective date; původní event se nesmí přepsat.

### R17-A-05 – deklarovaná immutabilita není vynucena jako celek

**Závažnost:** P2 hardening, součást R17 exit gate  
**Důkaz:** eventy se v běžné aplikační cestě přidávají, ale databáze nemá ochranu proti jejich UPDATE/DELETE. `work_session_events.session_id` používá `ON DELETE CASCADE`, takže smazání parent session smaže i auditní eventy. OpenAPI přitom seznam popisuje jako immutable historii.

**Dopad:** aplikační konvence není stejná jako vynucený auditní invariant.

**Požadovaná hranice:** produkční role nesmí mít UPDATE/DELETE nad event ledgerem a odstranění parentu nesmí tiše zničit auditní stopu. Testovací cleanup musí používat oddělenou privilegovanou testovací roli nebo explicitní test-only cestu.

### R17-A-06 – billed nebo rezervovanou session lze voidnout mimo účetní correction chain

**Závažnost:** P1 účetní blocker  
**Důkaz:** `voidWorkSession()` ani `removeTimeTracking()` nekontrolují `billingStatus`. Obě cesty mohou změnit session ve stavu `ready` nebo `billed` na `voided`, zatímco existující `work_session_billing_links` a invoice line zůstanou rezervované nebo vyfakturované.

**Dopad:** operativní součet času přestane obsahovat session, ale fakturační snapshot a invoice ji nadále obsahují. Vznikne nevysvětlený rozdíl mezi historií práce a účetním dokladem.

**Požadovaná hranice:** destruktivní void bez účetní návaznosti je povolen pouze pro `unbilled` session. `ready` vyžaduje atomické uvolnění draftové rezervace přes billing service. U `billed` je business void povolen například pro reklamaci nebo chybnou zakázku, ale musí vytvořit nový append-only void/correction event a navázaný záporný účetní podklad, storno nebo korekční doklad podle R13. Původní session, billed link ani vystavený doklad se nesmí přepsat nebo smazat.

## Pokrytí požadavků R17

| Požadavek                    | Stav                    | Poznámka                                                                                                               |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Effective-dated rates        | částečně                | Verze a intervaly existují; backdated create může přepsat známé snapshoty.                                             |
| Line/session snapshots       | převážně ano            | Session a billing link nesou snapshoty; před rezervací ale lze session přecenit.                                       |
| Source timezone/clock        | ne                      | Chybí timezone, offset i zdroj hodin; pracovní den se odvozuje z UTC.                                                  |
| Approval workflow času       | ne                      | Flag a billing blokace existují, approve/reject cesta ne.                                                              |
| Correction reason/event      | částečně                | Agregovaná korekce důvod má; void nebere lidský důvod a korekce není svázána s původem.                                |
| Vedoucí vs pracovník         | částečně                | Vlastní job timer je oddělen od `time.manage`; schvalovací oprávnění chybí.                                            |
| Explicitní billing snapshot  | ano po vytvoření draftu | Invoice line a work-session billing link snapshotují množství/sazbu/částku.                                            |
| Billing/correction integrita | ne                      | `ready`/`billed` session lze voidnout bez uvolnění nebo storna billing linku.                                          |
| Neznámá legacy historie      | částečně                | Nullable snapshoty zachovávají unknown, ale chybí explicitní klasifikace timezone/clock a kontrolovaný backfill event. |

## Doporučený implementační celek R17-B

R17-B má být jeden reviewovatelný celek, nikoli série drobných produkčních zásahů:

1. přidat novou migraci s auditními poli a event typy; číslo určit až po integraci aktuálního `main`, migraci `0100` nezařazovat;
2. ukládat source clock/timezone/offset a pro legacy použít pouze explicitní `unknown`;
3. zakázat přepis známých rate snapshotů; povolit jen doložený `NULL` backfill s eventem;
4. přidat approve/reject workflow a samostatné oprávnění vedoucího;
5. vyžadovat důvod a kategorii voidu; u `ready` atomicky uvolnit rezervaci a u `billed` vytvořit append-only time event i navázaný R13 účetní correction/storno chain bez změny původního dokladu;
6. zavést jednoznačnou vazbu korekce na původní session nebo schválené effective období;
7. rozšířit OpenAPI, klienta a administrátorské UI o review frontu a historii eventů;
8. doplnit DB/API/permission/concurrency testy, DST a půlnoční případy, test neměnnosti známého snapshotu a test, že void rezervované/vyfakturované session buď atomicky vytvoří celý schválený correction chain, nebo fail-closed;
9. backfill spustit pouze z prokázaných zdrojů; ostatní historické hodnoty ponechat explicitně neznámé.

## Schválený model pro R17-B

Pro korekci času je doporučený model **korekce konkrétní původní session**: původní interval zůstane beze změny a nový korekční záznam ponese `corrects_session_id`, důvod, aktéra, effective pracovní den a vlastní schválení. Agregované „nastav celkový čas“ lze zachovat jen jako manager workflow, které interně vytvoří takto doloženou korekci; nesmí tiše přecenit původní práci současnou sazbou.

## Checkpoint

- R17 není připraven k označení jako hotový ani k redesign gate.
- V tomto kroku nebyl změněn produkční kód a nebyla vytvořena ani spuštěna migrace.
- Nejbližší riziková hranice je schválení návrhu R17-B a vytvoření nové migrace; její spuštění v libovolném prostředí zůstává samostatným schválením.
