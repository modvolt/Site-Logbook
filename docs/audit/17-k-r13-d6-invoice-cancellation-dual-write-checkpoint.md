# R13-D6 – invoice cancellation dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark append-only void seam; R13 jako celek NOT READY**

## Výsledek

R13-D6 zapojuje `cancelInvoice` do již připraveného correction-bundle persistence kontraktu:

- exact gate `ACCOUNTING_CANCEL_INVOICE_DUAL_WRITE_ENABLED` přijme pouze hodnotu `true`; bez ní zůstává původní cancellation path beze změny;
- při zapnutém gate lze storno vytvořit jen k `issued` nebo `sent` faktuře s úplnou nativní version/lifecycle hlavou. Legacy issued faktura bez accounting head končí 409 a čeká na řízený `legacy_observation` backfill;
- původní issued version se nemění. Ve stejném invoice aggregate vznikne version 2 s purpose/document type `cancellation_notice`, `supersedesVersionId` původní verze a zero-balance cancellation snapshotem;
- cancellation version je zdroj `voids` relation na původní issued version. Na původní version je navázán další lifecycle event `void_confirmed`; reason, actor, timestamp, evidence hash a reason-detail hash jsou mezi eventem a relation atomicky ekvivalentní;
- přímá admin akce je one-step confirmation, proto nevymýšlí samostatný historický request event. Pokud bude později požadován dual-control workflow, musí přidat skutečný `cancellation_requested` event jako oddělený přechod;
- původní `invoices` řádek dál slouží jako current-state projection a přepne se na `cancelled`, ale neměnný issued snapshot i cancellation artifact zůstávají oddělené a relation je spojuje;
- stávající paid-evidence guard proběhne před bundlem, takže faktura s `paidDate`/`paidAmount` nebo statusem `paid` stále vyžaduje nejprve append-only payment correction.

## Cancellation PDF

- nový PDF artifact má vlastní titul `OZNÁMENÍ O STORNU FAKTURY`, číslo `<původní>-STORNO`, explicitní důvod a v textu původní částku;
- cancellation snapshot a PDF nesou nulový zůstatek; skutečná rušená peněžní hodnota zůstává autoritativně v relation targetu, tedy v původní issued version;
- PDF metadata dostávají deterministický file ID a creation timestamp z přesného evidence inputu. Stejný input proto vytvoří stejné bytes a SHA-256;
- object key obsahuje verzi a hash konkrétního cancellation attemptu. Pozdější retry po rollbacku tedy nepřepisuje jiný orphan attempt stejnou mutable cestou;
- běžná invoice PDF cesta používá stejné renderer API, ale nové deterministic/title/payment volby jsou optional; bez nich zůstává původní výstupní chování.

## Fault, replay a dark-path důkaz

Izolovaný PostgreSQL 16 test používá issued invoice vytvořenou přes R13-D4 seam a fault trigger na `accounting_export_outbox`:

- úspěch vytvoří přesně version 1 + version 2, issued + void-confirmed event, jednu `voids` relation, dva export intents a head revision 2;
- odmítnutý correction outbox rollbackne cancellation version/relation/event, status i `cancelledAt`; protože append probíhá před storage call, cancellation PDF se při tomto faultu vůbec neuploaduje;
- retry po odstranění faultu vytvoří právě jeden cancellation bundle a jeden PDF upload;
- druhé storno už zrušené faktury skončí existujícím 409 a nepřidá další version;
- zapnutý gate nad legacy issued fakturou odmítne fabrikovat nativní historii; vypnutý gate zachovává původní storno bez accounting rows a bez cancellation PDF uploadu.

## Bezpečnostní a provozní hranice

- flag se nesmí zapnout před číslovanou expand migrací, kontrolou journalu a staging cutoverem obou předchozích seamů;
- SQL zůstává pouze nečíslovanou šablonou; migration journal je 105/105, tail `0105_smooth_nitro`, bez `0100`;
- `sent` projection zatím nemá vlastní append-only event, protože `updateInvoiceStatus` zůstává další otevřený seam. D6 dokládá void původní issued version, ale neprohlašuje úplnost celé delivery historie;
- úspěšný cancellation PDF upload následovaný pozdější chybou při release job/material/work-session side effectu může ponechat orphan objekt. Unikátní attempt key zabrání jeho tichému přepsání, ale R12 storage reconciliation zůstává nutná;
- nebyl proveden commit, push, PR, workflow dispatch, GHCR/S3 zápis, deploy, backfill ani staging/produkční migrace.

## Ověření

- celý API unit/contract gate po R13-D6: **97 souborů, 748/748 PASS**;
- disposable PostgreSQL 16 cancellation success/fault/retry/legacy/dark sada: **4/4 PASS** nad standardními migracemi **105/105**, latest `0105_smooth_nitro`;
- společný izolovaný D5+D6 PostgreSQL 16 regresní běh: **7/7 PASS** ve dvou oddělených disposable databázích;
- TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaného Windows LF→CRLF upozornění;
- disposable PostgreSQL měl limit 0.75 CPU / 1 GiB, data na bounded tmpfs a byl po testu odstraněn; Docker skončil s nulou běžících kontejnerů.

## Co zbývá v R13

1. Integrovat veřejný `main`, forward-only vyřešit konflikt dvou `0096` a teprve potom očíslovat expand migraci; `0100` zůstává vyloučena.
2. Zapojit append-only `updateInvoiceStatus` včetně skutečného `sent` eventu a oddělit payment transition od lifecycle projection.
3. Zapojit `confirmBankPayments` a ruční payment cestu do append-only payment eventů; paid→sent přepis musí zůstat zakázán.
4. Přidat cost-document `review_reopened` + correction version chain a teprve pak uvolnit dočasný reopen zákaz z R13-D5.
5. Doložit Hetzner S3 capability, přidat create-only/versioned adapter, runtime worker cutover a řízený legacy backfill.

## Doporučený další řez

R13-D7 má začít `updateInvoiceStatus` kontraktem bez migrace: `sent` musí být lifecycle event nad current version a `paid` se nesmí modelovat stejným eventem, ale append-only payment eventem. Nejdřív je nutné přesně oddělit route semantics a idempotency, teprve potom zapojit oba persistence callery.
