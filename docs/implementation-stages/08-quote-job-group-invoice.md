# Etapa 8: Faktura z nabidky a cele akce

## Rozsah

Akce zakazek vytvorena z prijate cenove nabidky muze po dokonceni vsech
zakazek vytvorit jeden koncept faktury. Zaklad konceptu tvori snapshot polozek
prijate nabidky. Dalsi skutecne naklady se nepridavaji automaticky.

Administrator v dialogu explicitne oznaci pouze dokoncene navazujici zakazky,
ktere jsou schvalenou vicepraci. Pro tyto zakazky zvoli jeden z rezimu:

- cena zakazky,
- skutecne zaznamenany cas,
- bez ceny prace.

Spotrebovany oceneny material, doprava a parkovne vybranych vicepraci pouzivaji
stejna pravidla a rezervace jako standardni fakturace.

## Financni invarianty

- Polozky nabidky se kopiruji do invoice_lines se source_type = quote_item.
- Popis, mnozstvi, jednotkova cena a DPH jsou po vytvoreni ulozene na radku
  faktury; pozdejsi zmena nabidky je zpetne neprepocita.
- Prvni zakazka reprezentujici nabidku nemuze byt soucasne vybrana jako
  viceprace.
- Zadna dalsi zakazka se do ceny neprida bez explicitniho vyberu administratora.
- Vsechny dokoncene zakazky akce dostanou zdrojovou vazbu k fakture, aby je
  neslo soubezne pridat do jineho nestornovaneho konceptu.
- Material a cas vybranych vicepraci pouzivaji existujici rezervace s ochranou
  proti dvojimu vyfakturovani.
- Pred vystavenim lze koncept zkontrolovat a upravit. I po uprave se obnovi
  ochranna vazba vsech dokoncenych zakazek akce.

## Atomicke chovani

Funkce createQuoteJobGroupInvoiceDraft v jedne databazove transakci zamkne akci,
nabidku a vsechny jeji aktivni zakazky. Overi prijeti nabidky, shodu zakaznika,
dokonceni akce, vyber vicepraci a neexistenci jine aktivni fakturacni rezervace.

Ve stejne transakci:

1. vytvori koncept faktury,
2. zkopiruje polozky nabidky,
3. prida pouze vybrane viceprace,
4. rezervuje material a cas,
5. svaze vsechny dokoncene zakazky akce,
6. vytvori quote_invoice_links ve stavu reserved,
7. zapise quotes.converted_to_invoice_id,
8. zapise auditni udalost.

Unikatni castecny index nad aktivnim odkazem nabidky je druha databazova
ochrana proti soubehu.

## Zivotni cyklus

- Vytvoreni konceptu: odkaz je reserved.
- Vystaveni faktury: odkaz je billed, ceny v radcich zustavaji snapshotem.
- Smazani konceptu: odkaz je released, nabidka se uvolni a smazany invoice ID
  zustane v invoice_id_snapshot.
- Storno: odkaz je released; pri volbe vraceni zakazek se jejich stav vrati
  na done a lze vytvorit nahradni koncept.
- Odeslani nebo zaplaceni faktury nemeni zdrojovou vazbu.

## Migrace 0090

0090_secret_killmonger.sql pouze vytvari novou tabulku, indexy, kontroly a
cizi klice. Nemeni ani nedoplnuje existujici nabidky, faktury nebo zakazky.

Pred nasazenim:

1. zalohovat tabulky quotes, invoices, invoice_lines, invoice_source_links,
   jobs a migracni journal,
2. aplikovat 0090 v testovacim prostredi,
3. overit prazdnou tabulku quote_invoice_links,
4. spustit databazovy test soubehu,
5. pouzit jen nove testovaciho zakaznika, nabidku, akci a zakazky,
6. overit vytvoreni, upravu, smazani, nove vytvoreni, vystaveni a storno.

## Rollback

Preferovany rollback je nasadit predchozi API a frontend a aditivni tabulku
ponechat. Predchozi aplikace ji ignoruje a existujici faktury zustanou beze
zmeny.

Plny databazovy rollback 0090_secret_killmonger.down.sql je povolen pouze,
pokud je tabulka quote_invoice_links prazdna. Jakmile obsahuje i uvolnenou
historickou vazbu, skript se zablokuje. Historii nema administrator mazat jen
kvuli navratu aplikacni verze.

Pred aplikacnim rollbackem:

1. zastavit tvorbu novych konceptu z akci,
2. exportovat quote_invoice_links a dotcene nabidky/faktury,
3. nasadit predchozi API a frontend spolecne,
4. ponechat migraci 0090,
5. overit, ze existujici koncepty a vystavene faktury lze stale otevrit.

## Testovaci scenare

1. Nedokoncena zakazka v akci zablokuje tlacitko i API.
2. Akce bez prijate nabidky vrati 409.
3. Dve soubezna volani vytvori jeden koncept a jedno vrati 409.
4. Bez vybrane viceprace obsahuje koncept pouze snapshot nabidky.
5. Vybrana dokoncena viceprace se prida; nevybrana se neprida.
6. Prvni zakazku nelze vybrat jako vicepraci.
7. Zakazku jine akce nelze podvrhnout pres API.
8. Uprava konceptu nezrusi ochranu ostatnich zakazek akce.
9. Smazani konceptu uvolni nabidku a zachova historicky snapshot ID.
10. Vystaveni prepne rezervaci na billed.
11. Storno uvolni nabidku; nahradni koncept lze vytvorit az po navratu zakazek
    do fakturovatelneho stavu.
12. Uzivatel bez billing.manage tlacitko nevidi a API vrati 403.

Produkci ani existujici zaznamy pri overovani neupravovat.

## Lokalni overeni

- Cilene kontraktni a navazujici regresni testy: 39/39 uspesne.
- Cela frontendova sada: 78/78 uspesne.
- Cela API sada bez databazoveho pripojeni: 390 testu uspesne a 4 preskocene.
- Ctyri testy databazovych zamku selhaly pouze na nedostupnem PostgreSQL;
  dalsich 50 databazovych testovacich souboru se bez DATABASE_URL nenacetlo.
- TypeScript typecheck celeho workspace: uspesny.
- Produkcni build API: uspesny.
- Produkcni build frontendu a service workeru: uspesny; zustavaji existujici
  upozorneni na velikost bundlu a sourcemapy UI komponent.
- Kontrola git diff --check: bez chyb.

Databazovy test quote-job-group-invoice-db.test.ts je pripraven, ale nebyl
spusten. Pred nasazenim musi bezet nad izolovanou PostgreSQL databazi s
migracemi 0086-0090. Nesmí se spoustet proti produkcni databazi.
