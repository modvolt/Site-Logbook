# Etapa 10: Akceptacni audit workflow zakazky

## Ucel

Etapa uzavira lokalne overitelnou cast zmen workflow zakazek. Nepridava
databazovou migraci a neprovadi zadny zapis do produkce. Jejim vystupem je
sjednocena akceptacni sada, oprava read-only hranice a seznam bran, ktere musi
projit na izolovane kopii databaze pred produkcnim nasazenim.

## Nalezena a opravena chyba

Role `guest` ma ve vychozim stavu `jobs.view`, ale nema `jobs.work` ani
`jobs.manage`. Detail a seznam zakazek presto pouzivaly starsi kontrolu role
`can("write")` nebo pouze rozliseni terenniho rezimu. Read-only uzivatel proto
videl editacni tlacitka, ktera backend spravne odmital odpovedi 403.

Oprava rozdeluje tri rezimy:

- `jobs.view`: cteni bez spravcovskych mutaci,
- `jobs.work` bez `jobs.manage`: omezena prace na prirazene zakazce,
- `jobs.manage`: stav, termin, archivace, podpis, zakazkovy list a dokonceni.

Endpoint `GET /jobs/:id/completion-readiness` je nove explicitne chranen
`jobs.manage`. Read-only ani terenni uzivatel tak primym API volanim neziska
spravcovsky seznam bezicich casovacu ostatnich pracovniku.

Frontendove cesty pro novou zakazku, zakazkovy list a administraci pouzivaji
stejnou kombinaci `jobs.view` a `jobs.manage` jako backend. Odebrani jednoho z
nich uzivateli role `master` se proto projevi ihned i v UI a nezustane prekryte
puvodni roli. Domovska stranka pri chybejicim `jobs.view` dashboard zakazek
vubec nenamontuje, takze nevytvari serii ocekavanych odpovedi 403.

## Akceptacni matice

| Etapa | Lokalni dukaz | Stav | Nutna staging brana |
| --- | --- | --- | --- |
| 1 Archivace | aditivni migrace, soft-delete, guard a restore kontrakt | overeno staticky | archivace/obnova testovaci zakazky v DB |
| 2 Atomicke zalozeni | schema payloadu, transakce a izolovany uspesny/chybovy DB scenar | overeno na ciste DB | zopakovat nad anonymizovanou kopii |
| 3 Material | ledger kontrakt, plan, spotreba, navrat a vazby storna | overeno na ciste DB | zopakovat nad anonymizovanou kopii |
| 4 Dokonceni | policy, audit a atomicky hromadny prechod | overeno na ciste DB | staging API smoke test |
| 5 Vyjezdy | projektor rozvrhu, soft cancel a migracni kontrakt | overeno bez DB | kalendar/dashboard nad testovacimi daty |
| 6 Terenni rezim | backendove i frontendove permission kontrakty | overeno staticky | prihlaseni testovaciho terenniho uctu |
| 7 Nabidka na akci | lineage, zamky a atomicky DB kontrakt | overeno na ciste DB | staging API smoke test |
| 8 Faktura z akce | snapshot, soubezna rezervace a uvolneni konceptu | overeno na ciste DB | vystaveni a storno na stagingu |
| 9 Rollback retezec | 91 migraci a forward/down/forward 0086-0090 | overeno na ciste DB | forward/down/forward na obnovene kopii |
| 10 Read-only hranice | route, UI, lookup-query kontrakt a 10/10 mock browser testu | overeno bez DB | guest, field a manager smoke test s realnym staging API |

`overeno staticky` neznamena, ze byl proveden databazovy zapis. Produkcni
schvaleni vyzaduje vsechny staging brany v poslednim sloupci.

## Automaticke overeni

- Sjednocena akceptacni sada: 12 souboru, 64 testu, vse proslo.
- Nova read-only a terenni regresni sada: 2 soubory, 12 testu, vse proslo.
- Frontendova sada: 4 soubory, 78 testu, vse proslo.
- Typecheck knihoven, API, frontendu, mockupu a skriptu: vse proslo.
- Produkcni API build: uspesny.
- Produkcni frontend a service worker build s `BASE_PATH=/`: uspesny.
- Izolovany Playwright permission smoke test: 10/10 scenaru proslo na desktopnim
  a mobilnim viewportu bez skutecneho API; podrobnosti jsou v etape 12.
- Izolovana workflow DB sada na lokalnim PostgreSQL 18.4: 3/3 soubory a 6/6
  scenaru proslo po aplikaci 91/91 migraci; docasna databaze byla smazana.
- Izolovany migracni cyklus na lokalnim PostgreSQL 18.4: forward vsech migraci,
  DOWN 0090-0086, opetovny forward a kontrola idempotence prosly.

Cela API sada bez `DATABASE_URL` spustila 402 uspesnych a 4 preskocene testy.
Padesat souboru nebylo v tomto prostredi plne provedeno: 49 selhalo pri importu,
protoze primo vyzaduji `DATABASE_URL`, a 4 testy scheduler locku v jednom
souboru selhaly na nedostupnem lokalnim PostgreSQL portu 5432. Tyto vysledky se
nepocitaji jako funkcni chyby ani jako uspesne overeni; musi se zopakovat na
izolovane databazi.

Frontend build zachoval existujici upozorneni na velke chunky a sourcemapy
nekterych UI komponent. Build presto skoncil s kodem 0.

## Datova bezpecnost

- Pri teto etape nebyla nastavena ani pouzita `DATABASE_URL`.
- Vsechny DB testovaci prepinace byly odstraneny z prostredi prikazu.
- Nebyl spusten forward ani DOWN skript.
- Nebyla volana produkcni API.
- Nebyla vytvorena, upravena ani smazana produkcni zakazka.

## Rollback etapy 10

Etapa nema schema rollback. Aplikacni rollback vrati pouze zmeny opravneneho
zobrazeni v route `jobs.ts`, `App.tsx`, `layout.tsx`, `jobs.tsx`,
`dashboard.tsx`, `my-overview.tsx` a `job-detail.tsx`. Data vytvorena uzivateli
se nemeni ani nemazou.

Bezpecnejsi provozni varianta pri problemu je ponechat backendovy guard
`jobs.manage` na completion-readiness a vratit pouze problematickou frontendovou
revizi. Guard pouze omezuje cteni spravcovske diagnostiky a nema datovy dopad.

## Zbyvajici nasazovaci brany

1. Obnovit cerstvou zalohu do izolovane PostgreSQL stejne hlavni verze.
2. Zopakovat migrace 0086-0090 a databazove testy etap 1-8 nad anonymizovanou
   kopii historickych dat; beh nad prazdnou DB jiz prosel.
3. Spustit cely API test suite bez importnich chyb a bez preskoceni relevantnich
   workflow testu.
4. Overit read-only `guest`, terenni `guest + jobs.work` a spravce
   `jobs.manage` v prohlizeci na testovacich zaznamech.
5. Provest read-only preflight a zkousku aplikacniho rollbacku.
6. Plny DOWN retezec zkouset pouze na dalsi kopii bez blockeru.

Dokud tyto body neprojdou, zmeny jsou pripravene k testovacimu nasazeni, nikoli
prokazane jako hotove v produkci.
