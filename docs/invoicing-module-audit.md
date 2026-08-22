# Audit fakturačního modulu

Datum mapování: 17. 8. 2026
Rozsah: vydané faktury, zdroje práce a materiálu, sklad, stav zakázky, PDF a oprávnění. Původní mapování bylo provedeno read-only nad větví `origin/main` (`6ae3072`) a nad lokálně připojenou úpravou zákaznické podoby faktury. Následné integrační porovnání používá poslední stabilní checkpoint úkolu „Zmapuj projekt ve fázi 0“, commit `0c7a956`, který obsahuje migrační linii do `0107`. Produkční data ani produkční konfigurace nebyly změněny.

Produkční UX bylo následně ověřeno v přihlášené aplikaci `modvoltapp.cz` se souhlasem vlastníka a výhradně read-only navigací. Nebylo stisknuto uložení, vystavení, přepočet, smazání, odeslání ani změna stavu. Ověření potvrdilo, že „Vytvořit fakturu“ vede pouze do fronty hotových zakázek podle zákazníka a že produkční editor neobsahuje samostatný tok bez zakázky, zálohový typ, editaci odběratele, účet dokladu, sekce ani panel zdrojového vypořádání. Karta byla po kontrole vrácena na seznam faktur. Konkrétní zákaznické údaje z produkce se do auditu ani testovacích fixture nepřebírají.

## Shrnutí nálezu

Systém již umí vytvořit jeden koncept z více dokončených zakázek stejného zákazníka a API technicky přijme i koncept bez zakázky, pokud obsahuje zákazníka a ruční řádek. Uživatelské rozhraní ale samostatnou fakturu bez zakázky nenabízí. Zálohový doklad jako samostatný typ neexistuje.

Největší riziko je v tom, že `invoice_lines` současně představují zákaznické řádky i vazbu na provozní zdroje. Při nahrazení řádků editor smaže a znovu odvodí `invoice_source_links`; odstranění nebo sloučení obchodního řádku tak může uvolnit materiál, odpojit zakázku nebo ztratit informaci o tom, které zdroje byly paušálem vypořádány. Řádky skutečně odpracovaného času proto editor naopak zakazuje měnit, což neplní požadavek na plně editovatelný draft.

Skladová část má správnou hranici: materiál zakázky se vydává při potvrzení skutečné spotřeby (`materials.done`/`consumed_at`) přes append-only skladové pohyby. Tvorba ani vystavení vydané faktury sklad znovu neodečítá. Tento invariant se musí zachovat.

## Porovnání s úkolem „Zmapuj projekt ve fázi 0“

- Původní zadání tohoto úkolu bylo audit-only, jeho následná implementační linie ale doplnila migrace `0097`–`0107`, účetní a auditní evidenci, API idempotenci, veřejné tokeny, bezpečnější ukládání objektů a produkční/recovery control plane. Integrace proto nevychází z původního `6ae3072`, ale z posledního commitnutého checkpointu `0c7a956`.
- Přímý překryv byl v `invoice-service.ts`, `invoice-pdf.ts`, detailu a editoru faktury, OpenAPI a generovaných klientech, schématu faktur/indexu a migračním journalu. Konflikty byly sloučeny s předností pro novější účetní důkazy, idempotentní stavové přechody, povinný důvod storna, zákaz přepsání zaznamenané platby a ochranu veřejných Bearer endpointů; nové druhy faktur byly doplněny do těchto pravidel, nikoli kolem nich.
- Aktivní pracovní strom sledovaného úkolu po checkpointu dál připravuje dosud necommitnuté recovery/backup změny. Jejich aktuální seznam byl porovnán s commitnutou fakturační integrací a překryv je `0`. Nestabilní změny nebyly kopírovány ani upravovány; před releasem se fakturační větev dopojí až na jejich další autoritativní checkpoint.
- Migrační snapshot `0108` byl znovu vygenerován nad skutečným `0107_snapshot.json`. Jeho `prevId` přesně odpovídá `0107.id`, journal zachovává záměrně vynechanou `0100` a kanonický digest celé známé linie byl aktualizován na 108 řádků.

## Frontend

- `billing-unbilled.tsx` zobrazuje zákazníky s dokončenými podklady.
- `billing-unbilled-detail.tsx` vybírá více zakázek/akcí jednoho zákazníka, režim práce a přirážky; odtud vzniká jediný dostupný běžný tok tvorby konceptu.
- `billing-invoices.tsx` zobrazuje seznam a tlačítko nové faktury směruje do fronty nezpracovaných zakázek.
- `billing-invoice-edit.tsx` upravuje data, platbu, symboly, DPH, poznámku a řádky. Odběratel je jen ke čtení, chybí dodací adresa, účet dokladu, sekce, duplikace řádku a samostatný panel vypořádání zdrojů.
- `invoice-presentation-editor.tsx` odděluje zákaznický text od interních řádků pouze prezentačně. Umí textové slučování a rozdělení, ne plnou změnu množství, ceny a DPH souhrnné položky.
- `billing-invoice-detail.tsx` provádí vystavení, odeslání, označení úhrady a storno.
- Routy jsou chráněny `billing.view`, editor `billing.manage`; globální backend middleware vyžaduje `billing.manage` pro mutace.

## Backend a stavové přechody

- Hlavní logika je v `artifacts/api-server/src/lib/invoice-service.ts`, endpointy v `routes/billing.ts` a kontrakt v `lib/api-spec/openapi.yaml`.
- `createDraft` zamyká vybrané zdroje, ověřuje shodného zákazníka a připravuje řádky práce, materiálu, dopravy, parkování, pokut a schválených nákladů.
- Skutečné work sessions mají vlastní `work_session_billing_links` se stavy `reserved`, `billed`, `released` a aktivním unikátním omezením. To je bezpečný základ, ale pouze pro práci.
- Materiál a přefakturované nákladové řádky používají příznak/vazbu na koncept. Ostatní zdroje spoléhají na vazbu celé zakázky.
- `updateDraft` při úpravě řádků smaže všechny řádky, uvolní rezervace a odvodí zdrojové vazby z nového obchodního výstupu. U aktivních work sessions změnu zdrojových řádků blokuje.
- `issueInvoice` běží v transakci, zamyká fakturu, zakázky, akce i číselnou řadu, přidělí číslo a vystaví PDF. Druhé volání stejného vystavení však dnes vrací konflikt namísto idempotentního stejného výsledku.
- Při vystavení se zakázka přepne `done -> vyfakturovano`; částečný stav se nerozlišuje. Storno může vrátit zakázku na `done` a správně nevrací skutečně spotřebovaný materiál na sklad.
- Stavy faktury: `draft`, `issued`, `sent`, `paid`, `cancelled`. Dobropis ani opravný daňový doklad nejsou součástí tohoto modulu.
- PDF generuje `invoice-pdf.ts`; číslo a bankovní data se berou z `billing_settings`. Výstupní ISDOC se aktuálně negeneruje, sloupec je pouze připravený.

## Datový model

- `invoices` je snapshot odběratele a peněžních součtů, ale před vystavením není možné snapshot odběratele plně editovat. Při vystavení se navíc znovu přepíše z aktuální karty zákazníka.
- `invoice_lines` míchají obchodní řádek s `source_type`, `source_id`, `job_id` a `activity_id`.
- `invoice_source_links` propojují fakturu se zakázkou/akcí a částkou, ale nepopisují jednotlivé zdroje, částečné vypořádání ani paušál/bezplatně/odložit.
- `work_session_billing_links` řeší přesnou a souběžně bezpečnou rezervaci práce, nikoli materiál a ostatní zdroje.
- `materials` uchovávají skutečnou spotřebu a zákaznickou fakturační rezervaci. `warehouse_movements` jsou append-only a skladový servis používá zdrojovou identitu/idempotentní reconciliaci.
- Peníze jsou v databázi `numeric`, ale aplikační kalkulace používá JavaScript `number`; výpočet je nutné převést na přesnou celočíselnou/bodovou aritmetiku podle měnové přesnosti.

## Potvrzené chyby a mezery

1. UI neumí založit fakturu bez zakázky, ačkoli API to částečně dovoluje.
2. Neexistuje typ zálohové faktury, samostatná číselná řada ani správně označené PDF platební výzvy.
3. Zdrojové vypořádání je odvozeno z editovatelných řádků; obchodní úprava může změnit backendový význam.
4. Zaznamenanou práci nelze v obchodní podobě přepsat na `1 celek`, protože editor chrání zdrojový řádek namísto samostatné zdrojové vazby.
5. Ruční řádky při prvotním vytvoření zahazují předané `jobId`/`activityId`.
6. OpenAPI nabízí při PATCH `customerId`, route ani service ho ale neaplikují.
7. Odběratel se při vystavení znovu načte z karty a může přepsat záměrně upravený draft.
8. Celá zakázka je blokována první živou `invoice_source_link`; bezpečná částečná fakturace není možná.
9. Opakované vystavení stejného konceptu není idempotentní z pohledu klienta.
10. Významové změny zdrojového vypořádání nemají vlastní auditní záznam se starou a novou hodnotou.

## Cílový tok této úpravy

1. Draft je samostatný obchodní snapshot (`standard` nebo `advance`) a může vzniknout bez zakázky.
2. Obchodní řádky zůstanou plně editovatelné a dostanou typ `item`/`section`; zdrojová metadata na historických řádcích zůstanou jen kvůli kompatibilitě.
3. Nová evidence `invoice_source_allocations` drží každou work session, spotřebu materiálu a další zdroj nezávisle na obchodním řádku, včetně původního množství/hodnoty a způsobu `direct`, `included_in_lump_sum`, `not_charged` nebo `deferred`.
4. Koncept rezervuje standardní zdroje; zálohová platební výzva zdroje nevypořádává ani neblokuje jejich pozdější finální fakturaci.
5. Editace řádků alokace nemaže. Zdroje bez přímého řádku se explicitně označí paušálem nebo odložením a editor je ukáže v panelu Zdrojová data.
6. Vystavení pod zámkem přepne pouze neodložené alokace do finálního stavu. Opakované vystavení stejného ID vrátí stejný vystavený dokument bez dalšího čísla nebo pohybu.
7. Skladový výdej zůstane výhradně na hranici skutečné spotřeby; fakturace pouze vypořádá zákaznickou vazbu.
8. Zakázka zůstane `done`, pokud má odložené zdroje, a přejde na `vyfakturovano`, jen když jsou zdroje z daného konceptu plně vypořádané. Odvozený fakturační stav se zobrazí jako rozpracovaný/částečný/plný bez rozbití provozního workflow.

## Migrace a integrační omezení

Produkční release `6ae3072` stále končí migrací `0096`; stabilní lokální integrační linie pokračuje `0097`–`0107`, přičemž `0100` je záměrně vynechána. Fakturační změna je nyní vygenerovaná jako skutečně následující `0108_invoice_source_allocations_and_advances` nad `0107`, nikoli jako dřívější paralelní snapshot odvozený z `0096`. Historické faktury se nesmí zpětně hádat: backfill přebírá jen explicitní existující identity, nejednoznačné vazby označí jako `legacy_incomplete` a nechá je neaktivní. Zbývající release bránou je izolovaná PostgreSQL forward/rollback zkouška a následné dopojení na další commitnutý checkpoint aktivního recovery proudu.

## Post-0107 integrační rehearsal (2026-08-18)

- Poslední lokálně dostupný čistý checkpoint produkčního proudu je `8300469`; aktivní úkol však nad ním stále dokončuje P1 opravy a jeho pracovní strom není autoritativní release základ. Novější PR #22 checkpoint proto musí být po dokončení stacku znovu načten z finálního `main`.
- V izolovaném worktree `_invoice_after_8300469` se všechny tři fakturační commity přenesly na `8300469` bez textového konfliktu. Commitnuté ani tehdy rozpracované produkční změny neměly s 48 fakturačními cestami souborový překryv. Toto zjištění je rehearsal, ne náhrada opakované kontroly proti finálnímu SHA.
- Starý produkční runner `0096 -> 0107` původně vyžadoval celý aktivní journal o přesně 107 položkách, a po přidání `0108` proto fail-closed končil chybným hlášením o `0100`. Rehearsal jej zmrazuje pouze na ověřený prefix do `0107`; validní pozdější suffix se nestane krokem starého runneru ani součástí jeho cílového digestu.
- Oddělení DB rolí po `0107` ponechává budoucí objekty default-dark. Nová tabulka a serial sekvence proto vyžadují samostatný `0108` role kontrakt: runtime smí pouze `SELECT`, `INSERT`, `UPDATE` na `invoice_source_allocations` a `USAGE` na `invoice_source_allocations_id_seq`; `DELETE`, DDL, `PUBLIC`, třetí role a column grants jsou zakázané. Kontrakt je deaktivovaný ve výchozím stavu a vyžaduje exact-0107 plus default-dark pre-projekci.
- Následná integrace nad veřejným login/activation mergem `8787d7f` přidala samostatný source-pinned runner `0107 -> 0108`, post-migration role autoritu, exact-0108 readiness a podepsaný activation protokol v3. Historický runner zůstává zmrazený na `0096 -> 0107` a pro `0108` se nepoužívá.
- Nový control-plane exact-0107 backup producer vyžaduje zastavené runtime DB relace, vytvoří šifrovanou `mve1` zálohu bez retention prune, změří všechny tabulky ve stejném exportovaném snapshotu, provede disposable restore a až poté uloží no-clobber receipt/reference. Implementace ani artefakty samy neautorizují migraci nebo start aplikace; skutečný produkční běh zatím neproběhl.
- Aktuální lokální gate nad `8787d7f` je zelený: Node 329 pass + 1 PG16 skip, activation/DB 30 pass + 3 PG16 skip, frontend 193, live-events 15 a API 1069 pass + 1 skip. Cílený DB concurrency běh na novém disposable PostgreSQL 18 navíc prošel 11/11 scénářů. Exact PostgreSQL 16 lifecycle musí ještě potvrdit publikační CI nebo schválený izolovaný PG16 endpoint.

## Navazující integrační body (bez rozšíření rozsahu)

Přijatý doklad/fotografie/AI extrakce končí v `billing_documents` a `billing_document_lines`; schválení může řádky propojit s materiálem zakázky a nákladovou položkou. Fakturace přebírá pouze schválené a dosud nerezervované zdroje. Skladová reconciliace zůstává v material/warehouse service. Párování plateb pracuje nad vystavenou fakturou, variabilním symbolem a částkou. Budoucí fáze může rozšířit jednotnou alokaci i na částečné přefakturace přijatých dokladů a na účetní odečet zaplacené zálohy; nemá obcházet schválení dokladu ani skladový ledger.

## Implementované změny

- Přibyla samostatná cesta `Nový doklad`, která založí běžnou i zálohovou fakturu přímo na odběratele, s ruční položkou a bez povinné zakázky.
- Zálohová faktura má typ `advance`, vlastní číselnou řadu a PDF ji výslovně označí jako platební výzvu, nikoli daňový doklad. Nevytváří rezervace práce či materiálu, nemění zakázku a nevytváří ani nereverzuje skladový pohyb.
- Standardní koncept z jedné či více zakázek zachovává jednotlivé raw zdroje v `invoice_source_allocations`, zatímco zákaznické položky lze slučovat po zakázkách nebo napříč zakázkami.
- Draft umožňuje změnit snapshot odběratele, fakturační a dodací adresu, data, účet/IBAN/BIC, měnu, symboly, poznámku a všechny obchodní vlastnosti řádku. Lze přidávat, duplikovat, mazat a přesouvat položky a vkládat sekce.
- Existující řádky se upravují pod stabilním ID. Smazání řádku nemaže zdroj: připojené zdroje se jednoznačně převedou na paušál nebo odložení a administrátor může výsledek změnit v panelu vypořádání. Změna se zapisuje do auditu.
- Panel `Vypořádání zdrojů` ukazuje zakázky, raw množství, interní hodnotu, obchodní součet a rozdíl. Každý zdroj lze nastavit na přímou fakturaci, paušál, bezplatné vypořádání nebo další fakturu.
- Změna odběratele proti zdrojovým zakázkám je výchozím způsobem blokována. Explicitní výjimku smí potvrdit pouze role `admin`/`master` a vznikne zvláštní auditní záznam; původní zákazník zakázky se nemění.
- Vystavení používá ID konceptu jako idempotentní klíč. Stejný vystavený koncept vrátí stejné číslo a snapshot. Číselná řada, zdroje, stav dokladu a audit se mění v jedné databázové transakci.
- Peněžní výpočty řádků, slev, přirážek a DPH používají celočíselné centy a bazické body namísto průběžného floating-point sčítání.

## Nový datový tok

1. Dokončená zakázka/akce nabídne pouze raw zdroje, které nejsou aktivně rezervované nebo finálně vypořádané jinou standardní fakturou.
2. Vytvoření standardního konceptu pod zámkem založí obchodní snapshot, zdrojové alokace ve stavu `reserved`, vazby na všechny zakázky/akce a návrh zákaznických řádků. Záloha může obchodně odkazovat na zakázku, ale nevytváří provozní alokace; samostatný tok bez zakázky začíná ručním obchodním řádkem.
3. Editace mění obchodní snapshot a řádky, nikoli časové záznamy, spotřebu materiálu nebo skladový ledger. Zdrojová alokace může, ale nemusí ukazovat na konkrétní obchodní řádek.
4. Vystavení znovu přesně přepočítá řádky, zamkne fakturu, zdroje a číselnou řadu, přidělí číslo, uloží PDF a převede alokace na `billed`, `included_in_lump_sum`, `not_charged` nebo `deferred`.
5. Odložená práce a zákaznická rezervace materiálu/nákladového řádku se uvolní pro další fakturu. Zakázka s odloženými zdroji zůstane provozně `done` a API/UI odvodí částečný fakturační stav; plně vypořádaná zakázka přejde na stávající `vyfakturovano`.
6. Skladový výdej zůstává u skutečné spotřeby materiálu. Faktura pouze zapisuje zákaznické vypořádání; vystavení ani storno faktury množství na skladě nemění.
7. Smazání draftu uvolní rezervace. Storno vystaveného standardního dokladu reverzuje obchodní vypořádání a zpřístupní zdroje, ale fyzicky spotřebovaný materiál automaticky nevrací.

## Změněné oblasti a soubory

- Databáze: `lib/db/src/schema/invoices.ts`, `billing-settings.ts`, nový `invoice-source-allocations.ts`, export v `schema/index.ts`, migrace a snapshot `0108`, rollback a read-only rollback preflight.
- API a doména: `invoice-service.ts`, `invoice-calc.ts`, `invoice-pdf.ts`, nové `invoice-source-planning.ts` a `invoice-document-kind.ts`, mapování rout v `routes/billing.ts`.
- Kontrakt: `lib/api-spec/openapi.yaml`, konfigurace Orval a znovu vygenerované klienty v `lib/api-client-react` a `lib/api-zod`.
- Frontend: nová stránka `billing-invoice-new.tsx`, routa v `App.tsx`, seznam `billing-invoices.tsx`, výběr zdrojů `billing-unbilled-detail.tsx`, editor a detail faktury a nastavení samostatné zálohové číselné řady.
- Testy: nové testy přesné kalkulace, druhu dokladu, plánování agregace a migračního/alokačního kontraktu; rozšířené kontrakty editoru, zdrojových vazeb a DB souběhu.

## Migrace a návrat

1. **Hotovo:** `0108_snapshot.json` je přegenerovaný proti skutečnému předchůdci `0107`; `0100` zůstává nepoužitá a test kontroluje přesný řetězec snapshotů.
2. **Ověřeno na disposable PostgreSQL 18:** forward, least-privilege role delta, read-only preflight, povolený DOWN na prázdných nových datech a druhý forward. Exact PG16 varianta zůstává neprovedená.
3. **Produkční běh čeká:** nový exact-0107 backup/restore receipt, durable intent, jediná 0108 transakce, role receipt a v3 activation bundle se musí vytvořit až z publikovaného finálního SHA.
4. Při nejasném COMMIT/ROLLBACK nebo nedurable receiptu se migrace nesmí slepě opakovat; runner vrátí `RESTORE_REQUIRED`. Tento pracovní strom nic nenasadil.

## Automatické ověření

- OpenAPI/Orval codegen: úspěšný; následný knihovní TypeScript build úspěšný.
- TypeScript: knihovny, API server, frontend, skripty i pomocný mockup bez chyb.
- Fakturační čistě lokální unit/contract sada: 7 souborů, 48 testů, vše úspěšné. Pokrývá přesnou kalkulaci, 8,5 h ze čtyř záznamů a dvou zakázek, agregaci stejného materiálu, oddělení ručních/sekčních řádků, lifecycle stavů alokace, stabilní ID řádku, bezpečné smazání položky, jobless/advance kontrakt, PDF popisky a stávající QR/presentační regrese.
- Plná hermetická API sada po aktualizaci migračních a CRLF/LF kontraktů: 131 souborů, 968 testů, vše úspěšné. Samostatné účetní kontrakty vystavení/storna/platby: 11 testů, vše úspěšné.
- ESLint: celý workspace bez varování a chyb.
- Produkční build API: úspěšný.
- Produkční build frontendu/PWA s `BASE_PATH=/`: úspěšný, 4 020 modulů a 234 precache položek; zůstává obecné upozornění Vite na některé chunky nad 500 kB.

DB-backed test souběžného vytvoření konceptu, dvojího vystavení, storna a opakovaného vystavení prošel na novém disposable PostgreSQL 18: 1 soubor, 11/11 testů. Produkční databáze k testu použita nebyla a dočasný cluster byl po běhu zastaven a odstraněn. Upravené UI zatím nebylo přihlášeně proklikáno proti lokálnímu backendu; produkční relace sloužila pouze k read-only auditu původního stavu.

## Manuální testovací postup pro administrátora

Na izolované testovací databázi s kopií neprodukčních dat:

1. Spustit migrační preflight/forward a otevřít Fakturace → Faktury → Nový doklad.
2. Vytvořit běžnou fakturu bez zakázky, upravit odběratele, adresy, bankovní účet, měnu, data, sekci a několik ručních řádků; uložit, znovu otevřít a porovnat snapshot.
3. Vytvořit zálohovou fakturu bez zakázky, vystavit ji a zkontrolovat samostatné číslo, text „nejde o daňový doklad“, PDF/QR a nulovou změnu zakázek, raw zdrojů i skladu.
4. Připravit dvě zakázky stejného zákazníka se čtyřmi work sessions 2 h + 1,5 h + 3 h + 2 h. Zvolit sloučení napříč zakázkami a ověřit jednu položku 8,5 h a čtyři raw alokace v panelu.
5. Přepsat položku na „Kompletní elektromontážní práce“, `1 celek`, vlastní cenu; uložit a ověřit, že čtyři časové záznamy zůstaly beze změny a alokace jsou stále dohledatelné.
6. Na dvou zakázkách použít dohromady 8 ks stejného materiálu. Porovnat skladový ledger před konceptem, po konceptu, po vystavení a po opakovaném vystavení: faktura nesmí přidat žádný další skladový pohyb.
7. Smazat automatický materiálový řádek. Ověřit oznámení o zachování zdroje, změnit volbu mezi paušálem, bezplatně a odložit, uložit a zkontrolovat audit.
8. Označit část zdrojů jako `deferred`, vystavit a ověřit částečný fakturační stav a dostupnost odložených zdrojů v dalším konceptu.
9. Dvakrát souběžně odeslat vystavení stejného ID a ověřit jeden doklad, jedno číslo, jeden PDF snapshot a jeden settlement. Současně založit dva koncepty nad stejným raw zdrojem a ověřit jednu úspěšnou rezervaci a jednu srozumitelnou odpověď 409.
10. Smazat jiný draft a ověřit uvolněné zdroje, stav zakázky a beze změny skladový ledger.
11. Zkusit zdroje jiného zákazníka: běžný uživatel musí dostat blokaci; správce může změnu odběratele potvrdit pouze explicitně a audit musí obsahovat výjimku bez změny zákazníka zakázky.
12. Regresně otevřít starší jednotlivou fakturu, stáhnout PDF, prověřit odeslání/úhradu/storno na testovacích datech a následně spustit rollback preflight.

## Známá omezení

- `0108` správně navazuje na commitnutou linii `0097`–`0107`; disposable PostgreSQL 18 lifecycle i DB concurrency prošly. Exact PG16 zůstává otevřenou release bránou.
- Finální integrační základ je veřejný login/activation merge `8787d7f`; fakturační release a control-plane změny jsou zatím pouze v lokální větvi a nebyly publikovány ani nasazeny.
- Zálohová faktura je v této změně platební výzva. Automatické vytvoření daňového dokladu k přijaté platbě ani automatický odečet zaplacené zálohy na konečné faktuře zatím implementovány nejsou; to vyžaduje navazující účetní fázi.
- Částečný fakturační stav je odvozený `billingState`, nikoli nový provozní enum zakázky, aby se nerozbilo současné workflow `done`/`vyfakturovano`.
- ISDOC zůstává mimo rozsah stejně jako v původním modulu; ověřuje se PDF a stávající exportní chování.
- Bez exact PostgreSQL 16 lifecycle brány a přihlášeného live smoke nelze tvrdit plné DB/E2E ani vizuální přijetí.
