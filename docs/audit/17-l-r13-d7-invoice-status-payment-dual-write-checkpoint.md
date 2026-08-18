# R13-D7 – invoice status/payment dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark lifecycle/payment seam; R13 jako celek NOT READY**

## Výsledek

R13-D7 odděluje doručení faktury od přijetí platby a zapojuje oba existující public callery do immutable accounting persistence kontraktu:

- exact `ACCOUNTING_INVOICE_STATUS_DUAL_WRITE_ENABLED=true` zapíná evidence pro ruční `updateInvoiceStatus`;
- exact `ACCOUNTING_BANK_PAYMENT_DUAL_WRITE_ENABLED=true` zapíná evidence pro `confirmBankPayments`;
- `sent` vytváří pouze další hash-linked lifecycle event `sent` nad current immutable invoice version. Nevytváří novou document version ani payment event;
- ruční `paid` a bankovní confirmation vytvářejí pouze append-only payment event `received`. Nemodelují platbu jako lifecycle status;
- event, canonical export intent, aggregate-head CAS, původní audit row a mutable `invoices` projection sdílejí jednu caller-owned DB transakci;
- opakování přesně stejného již uloženého `sent` nebo `paid` stavu je no-op a nevytváří duplicitní evidence;
- zapnutý gate odmítne legacy invoice bez nativního accounting headu a také `sent` projection, jejíž lifecycle head neobsahuje skutečný `sent` event. Historie se zpětně nedoplňuje odhadem.

## Payment provenance a souběh

- ruční event používá `source=manual`, `reasonCode=payment_received` a nulový `sourceRefSha256`;
- bankovní event používá `source=bank_import`, `reasonCode=payment_imported` a domain-separated SHA-256 normalizovaných confirmation fields: amount, currency, date, variable symbol a counterparty;
- raw variable symbol ani counterparty se do canonical payment eventu neukládají;
- tento digest **není** důkaz raw bankovního souboru ani provider transaction ID. Původní confirm API takový serverově ověřený identifikátor nepřenáší; silnější raw-statement binding vyžaduje samostatný preview grant/ledger;
- deduplikovaný multi-invoice bankovní batch řadí invoice IDs vzestupně před prvním row lockem. Tím odstraňuje opačné pořadí z klientského payloadu jako zdroj batch lock inversion;
- fault na pozdějším outbox insertu rollbackne i dříve zpracovanou fakturu v témže bankovním batchi.

## Fault, replay a dark-path důkaz

Izolovaný PostgreSQL 16 test prokazuje:

- issue → sent → manual paid vytvoří jednu version, dva lifecycle events, jeden payment event, tři export intents a aggregate revision 3;
- opakované sent/paid volání zachová přesně jeden nový event každého typu;
- odmítnutí payment export intentu rollbackne payment event, head i paid projection; retry následně vytvoří jediný event;
- bankovní confirmation vytvoří právě jeden `bank_import` payment event a neuloží raw counterparty;
- dvoufakturový batch zadaný v opačném pořadí je interně seřazen; odmítnutí outboxu druhé faktury rollbackne obě, retry uloží právě dvě platby;
- legacy a lifecycle-drifted faktura jsou při zapnutém gate fail-closed;
- při vypnutých gatech zůstává původní manual i bankovní chování beze změny a nevznikají accounting rows.

## Bezpečnostní a provozní hranice

- flagy se nesmí zapnout před číslovanou expand migrací, kontrolou journalu a staging cutoverem D4–D6;
- SQL zůstává pouze nečíslovanou šablonou; migration journal je 105/105, tail `0105_smooth_nitro`, bez `0100`;
- current API označí fakturu jako `paid` po jediném received eventu. Partial/multiple payments, refund, reversal a correction command paths zatím nejsou zapojeny, i když canonical contract je podporuje;
- batch stále deduplikuje dvě platby stejné faktury v jednom requestu. To zachovává současný business tok, ale není to cílový multiple-payment model;
- raw bank statement/providery nejsou persistovány ani serverově svázány s confirmation eventem;
- nebyl proveden commit, push, PR, workflow dispatch, GHCR/S3 zápis, deploy, backfill ani staging/produkční migrace.

## Ověření

- celý API unit/contract gate po R13-D7: **98 souborů, 752/752 PASS**;
- R13-D7 pure contract/policy sada: **8/8 PASS**;
- disposable PostgreSQL 16 D7 success/fault/retry/batch/legacy/drift/dark sada: **6/6 PASS**;
- společný izolovaný R13-D4 až D7 regresní běh: **16/16 PASS** ve čtyřech disposable databázích nad migracemi **105/105**, latest `0105_smooth_nitro`;
- TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaného Windows LF→CRLF upozornění;
- PostgreSQL kontejner měl limit 0.75 CPU / 1 GiB, data na bounded tmpfs a po testu byl odstraněn.

## Co zbývá v R13

1. Integrovat veřejný `main`, forward-only vyřešit konflikt dvou `0096` a teprve potom očíslovat expand migraci; `0100` zůstává vyloučena.
2. Přidat cost-document `review_reopened` + correction version chain a teprve potom uvolnit dočasný reopen zákaz z R13-D5.
3. Přidat explicitní partial/multiple payment commands a append-only `corrected`/`refunded`/`reversed` přechody; žádný z nich nesmí přepisovat původní `received` event.
4. Navrhnout serverově ověřený bank-statement preview grant nebo import ledger, pokud má source evidence dokazovat raw statement bytes/provider transaction.
5. Doložit Hetzner S3 capability, přidat create-only/versioned adapter, runtime worker cutover a řízený legacy backfill.

## Doporučený další řez

R13-D8 má dokončit poslední terminální caller `setDocumentStatus`: `review_reopened` musí být skutečný lifecycle event s povinným reason detailem a zároveň musí vzniknout nová editable correction version/revision, nikoli přepsání schváleného snapshotu. Nejdřív je nutné zmapovat přesnou dnešní reopen → edit → reapprove sekvenci a zvolit, zda current draft revision potřebuje nový persistence typ, nebo zda se correction version vytvoří až při následném approval.
