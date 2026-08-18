# R13-D4 – issued invoice dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark jediný caller seam; R13 jako celek NOT READY**

## Výsledek

R13-D4 zapojuje právě jeden terminální write seam, `issueInvoice`, do dříve připravené caller-owned accounting transakce:

- exact gate `ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED` přijme jen hodnotu `true`; chybějící, `false` nebo whitespace varianta zachová původní issue cestu bez přístupu k dosud nemigrovaným accounting tabulkám;
- po finálním přepočtu, přidělení čísla a customer snapshotu vzniká canonical outgoing-invoice snapshot dodavatele, odběratele, všech ordered řádků, totals a deduplikovaných/agregovaných source links;
- podporované source typy odpovídají skutečným invoice řádkům včetně `activity_work`, `activity_material` a `quote_item`; neznámý typ je při zapnutém gate odmítnut, nikoli ztrátově přemapován;
- fixed-scale PostgreSQL decimal hodnoty se převádějí do canonical tvaru bez zaokrouhlení; scale nad čtyři místa, exponent nebo neplatné ID failují;
- rendered PDF artifact váže SHA-256 přesných bytes, velikost, domain-separated hash object path a renderer `invoice-pdf/v1`; version a event IDs jsou deterministické domain-separated UUID odvozené z přesného issue evidence;
- nativní evidence má úplný provenance záznam pro každý scalar/null leaf snapshotu. `sourceMode=system` přesně znamená system-captured stav v okamžiku issue; issuing user je autentizovaný schvalovatel, nikoli domyšlený autor všech dřívějších draft editů;
- caller-owned adapter atomicky vloží initial version, sequence-zero `issued` event, export intent a aggregate-head revision před PDF uploadem a před zbývajícími invoice side effecty;
- původní `audit_log` zápis zůstává jako legacy telemetry, ale accounting evidence je samostatný canonical stream a nepředstírá, že generic audit log je immutable.

## Fault a replay důkaz

Izolovaný PostgreSQL 16 test vkládá fault trigger na `accounting_export_outbox`:

- odmítnutý outbox insert rollbackne invoice status, invoice number, `issuedAt`, PDF path, number sequence i všechny version/event/head řádky;
- protože evidence append je před storage call, PDF upload se při tomto selhání vůbec nezavolá;
- po odstranění faultu retry uspěje, posune number sequence jen jednou a vytvoří jediný accounting stream;
- druhý issue stejné už vydané faktury skončí existujícím 409 guardem a nepřidá další version/event/outbox;
- při dark flagu zůstává původní issue behavior a žádný accounting row nevzniká.

## Bezpečnostní a provozní hranice

- flag se nesmí aktivovat před číslovanou expand migrací, kontrolou jejího journalu a samostatným staging cutoverem; aktuální produkční i staging env zůstaly beze změny;
- SQL je nadále pouze `docs/audit/17-f-r13-accounting-evidence-expand.template.sql`; `lib/db/migrations` zůstává 105/105, tail `0105_smooth_nitro`, bez `0100`;
- archive worker není zapojen do API startupu ani scheduleru, Hetzner S3 nebyl kontaktován a nebyl proveden provider write;
- nebyl proveden commit, push, PR merge, workflow dispatch, deploy, backfill ani staging/produkční migrace;
- úspěšný PDF upload následovaný pozdější DB chybou může stále zanechat orphan objekt. D4 tento známý R12 DB–storage residual nezakrývá a neprovádí nebezpečný compensating delete nad deterministickou cestou;
- D4 zachycuje úplný stav při issue, ale neregeneruje historický field-level původ dřívějších draft editů. Budoucí draft provenance musí přidat vlastní append-only events, nikoli měnit tento snapshot zpětně.

## Ověření

- issued-invoice builder, document contract a write-seam registry: **19/19 PASS**;
- disposable PostgreSQL 16 issue/fault/replay/dark-gate sada: **3/3 PASS** nad standardními migracemi **105/105**, latest `0105_smooth_nitro`;
- celý API unit/contract gate: **95 souborů, 741/741 PASS**;
- API TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaných Windows LF→CRLF upozornění;
- disposable PostgreSQL měl limit 0.75 CPU / 1 GiB, data na bounded tmpfs a po testu byl odstraněn; Docker skončil s nulou běžících kontejnerů.

## Co zbývá v R13

1. Integrovat veřejný `main` a forward-only vyřešit konflikt dvou různých `0096`; až potom přidělit nové skutečné číslo expand migrace. `0100` zůstává vyloučena.
2. Připravit druhý default-dark seam pro `approveDocument`, který musí navíc přesně svázat původní soubory, AI/ISDOC/human provenance a approved line/reference snapshot; nesmí sdílet volný fallback s invoice builderem.
3. Implementovat append-only cancellation/correction/payment cesty pro `cancelInvoice`, `updateInvoiceStatus` a `confirmBankPayments`; business void musí vytvořit nový artifact/event/relation chain, nikoli přepsat issued version.
4. Doložit Hetzner S3 capability preflight a teprve potom přidat konkrétní create-only/versioned adapter a samostatně aktivovat archive worker.
5. Připravit dry-run legacy inventory a samostatný idempotentní `legacy_observation` backfill bez domyšlených actorů, eventů nebo časů.

## Doporučený další řez

R13-D5 má zůstat bez migrace a bez externích zápisů: zapojit jediný `approveDocument` seam za samostatný exact dark flag, vytvořit canonical approved cost-document snapshot a fault-testovat rollback před jakýmkoli nezvratným side effectem. Číslovaná migrace, provider aktivace a runtime cutover zůstávají pozdější samostatné approval boundaries.
