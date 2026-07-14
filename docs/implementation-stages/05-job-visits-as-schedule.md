# Etapa 5: Vyjezdy jako skutecny rozvrh zakazky

## Rozsah

- Datum na zakazce zustava prvnim pracovnim terminem.
- Kazdy dalsi den stejne zakazky je samostatny vyjezd.
- Vyjezdy se propisuji do kalendare, dashboardu Dnes a souhrnnych poctu.
- Presun vyjezdu v kalendari meni pouze vyjezd, nikoli hlavni datum zakazky.
- Vyjezd muze mit vlastni cas; bez nej dedi cas zakazky.
- Zruseni je mekke (`status = cancelled`) a zachovava historii i audit mutace.
- Zapis ridi opravneni `jobs.manage`, cteni `jobs.view`.
- Duplicitni aktivni vyjezd se stejnym terminem, technikem a casem vraci HTTP 409.

Migrace 0088 pouze pridava sloupce `start_time`, `end_time`, `updated_at` a dva indexy. Pri nasazeni neupravuje ani nemaze existujici zaznamy.

## Pravidla projekce

Jednotny backendovy projektor sklada hlavni termin zakazky a jeji vyjezdy. Pokud stary zaznam obsahuje vyjezd ve zcela stejnem slotu jako hlavni termin, explicitni vyjezd ma prednost. Pokud historicka data obsahuji nekolik totoznych vyjezdu, v rozvrhu se zobrazi nejstarsi z nich; zadny databazovy radek se automaticky nemaze.

Dashboard zobrazuje jednu kartu zakazky za den, i kdyz ma vice vyjezdu. Zachova tak jednoznacne ovladani karty, ale uvede vsechny techniky a identifikatory vyjezdu daneho dne. Kalendar zobrazuje jednotlive vyskyty samostatne.

## Overeni pred nasazenim

1. Aplikovat migraci 0088 v testovacim prostredi a overit vsechny tri nove sloupce.
2. Zalozit testovaci zakazku na prvni den a pridat vyjezd na druhy den.
3. Overit oba dny v kalendari a druhy den na dashboardu Dnes.
4. Presunout druhy den v kalendari a overit, ze datum zakazky zustalo beze zmeny.
5. Zmenit cas druheho dne v dennim kalendari a overit pouze zaznam vyjezdu.
6. Zkusit pridat totozny vyjezd podruhe; API musi vratit 409.
7. Zrusit vyjezd; musi zmizet z rozvrhu, ale zustat v detailu jako zruseny.
8. Obnovit zruseny vyjezd upravou stavu na `planned`.
9. Overit, ze uzivatel bez `jobs.manage` dostane pri POST, PATCH a DELETE odpoved 403.

## Rollback aplikace

Nejbezpecnejsi rollback je nasadit predchozi API a frontend spolecne a databazove sloupce z migrace 0088 ponechat. Jsou aditivni a starsi aplikace je ignoruje. Vyjezdy vytvorene za behu nove verze zustanou zachovane.

Pred rollbackem zastavit nove deploye, zaznamenat cas prepnuti a po navratu overit detail zakazky, kalendar a dashboard na testovaci zakazce. Provozni terminy se automaticky nevraceji, protoze mohou byt platnou historii.

## Plny databazovy rollback

Soubor `lib/db/rollbacks/0088_abandoned_wendell_vaughn.down.sql` je urcen pouze pro planovany zasah se zastavenym API. Skript se sam zablokuje, pokud je u libovolneho vyjezdu ulozen vlastni cas. Pred jeho pripadnym spustenim je nutne:

1. exportovat tabulku `job_visits`,
2. overit nulovy pocet neprazdnych `start_time` a `end_time`,
3. zastavit vsechny instance API,
4. spustit rollback v transakci,
5. nasadit predchozi verzi aplikace,
6. overit pocet a obsah vyjezdu proti exportu.

Rollback nikdy nespoustet automaticky v produkcnim deploy pipeline.
