# Etapa 2: Atomicke zalozeni zakazky

## Rozsah

`POST /api/jobs` prijima zakladni zakazku a volitelne kolekce `assigneeIds`,
`tasks` a `materials`. Zakazka, dalsi pracovnici, ukoly a materialy se zapisuji
v jedne databazove transakci.

Pred transakci API overi:

- existenci vsech pracovniku,
- kolizi vsech pracovniku s dovolenou,
- existenci zakaznika,
- existenci explicitne vybranych skladovych polozek,
- strukturu a maximalni pocty vnorenych zaznamu.

Soubezne zalozeni zakazek pro stejny den serializuje poradove cislo pomoci
transakcniho advisory locku.

## Zpetna kompatibilita

Nova pole jsou volitelna. Starsi klient muze dale poslat pouze zakladni zakazku.
Nove vytvorene zaznamy pouzivaji stavajici tabulky a nevyzaduji novou migraci.

## Nasazeni

1. Nasadit frontend a API ze stejne revize.
2. Na testovaci zakazce zalozit dva pracovniky, jeden ukol a jeden material.
3. Overit jedinou zakazku, vazbu pracovnika, ukol a planovany material bez skladoveho pohybu.
4. V logu nesmi byt nasledne volani samostatnych endpointu pro assignees, tasks nebo materials z formulare.

## Rollback

Etapa nema databazovou migraci. Rollback znamena vratit soubory API kontraktu,
route a formulare na predchozi revizi a nasadit frontend i API soucasne.
Zakazky vytvorene novym postupem zustanou bez zmeny, protoze jsou ulozene ve
stejnych tabulkach jako drive.

Pri rollbacku muze starsi API ignorovat nova pole payloadu. Proto se nesmi
vratit pouze API a ponechat novy frontend; frontend a API se vraceji spolecne.

## Testy

- Kontrakt overuje validaci vnorenych poli a limity kolekci.
- Staticky test hlida, ze vsechny zapisy jsou uvnitr `db.transaction`.
- Databazovy test vytvori kompletni zakazku a overi vsechny vazby; po etape 3
  take overi spotrebu, skladovy vydej a opravny pohyb pri vraceni do planu.
- Databazovy test zpusobi selhani druheho materialu po zapisu prvniho a overi
  rollback zakazky, vazeb, materialu i nezmeneny stav skladu.

Databazove testy se smi spoustet pouze nad izolovanou testovaci databazi a
vyzaduji vedle `DATABASE_URL` take explicitni
`ATOMIC_JOB_DB_TEST_ENABLED=true`. Samotna produkcni `DATABASE_URL` test
nespusti.

## Navazujici zmena

Etapa 3 zmenila pocatecni material na planovany. Skladovy vydej se od etapy 3
provede az explicitnim oznacenim materialu jako spotrebovaneho.
