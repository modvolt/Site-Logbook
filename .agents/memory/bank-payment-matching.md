---
name: Bank payment matching (Stavba fakturace)
description: Design constraints for matching incoming bank payments (KB GPC/CAMT.053) to invoices and marking them paid.
---

# Bank payment matching

Admin uploads a Komerční banka statement (GPC/ABO fixed-width text or CAMT.053
XML); the server parses incoming (credit) transactions, proposes invoice matches
by **variable symbol + amount**, and on confirm marks matched invoices `paid`.

## Durable decisions

- **Stateless 2-step flow, no new DB tables.** Parse/preview is read-only;
  confirm marks invoices paid. Statement bytes are never persisted — only the
  resulting audit entries are.
- **Confirm MUST reuse the shared paid-transition path, not a raw status write.**
  The invoices table already has `paid_date` / `paid_amount` columns (added by a
  separate task; in schema as `paidDate`/`paidAmount`). `confirmBankPayments`
  calls the shared `paidTransitionFields(invoice, {paidDate, paidAmount})` helper
  (also used by `updateInvoiceStatus`) inside its own tx, passing the bank
  transaction's actual amount/date (falling back to today / invoice total). A
  bare `set({status:'paid'})` was rejected in review for leaving payment metadata
  inconsistent with the manual status path.
  **Why:** bank-confirmed and manually-marked payments must persist identically.
- **Matching is decoupled from the file format.** The parser emits a normalized
  `BankTransaction[]`; matching/confirm live in invoice-service. A future live
  bank API (PSD2) feed should produce the same shape and reuse
  `confirmBankPayments` — do not re-implement matching in the API path.
  **Why:** PSD2 direct access needs eIDAS certs / ČNB registration / 90-day SCA
  reconsent, so statement import is the pragmatic first step.

## Matching rules (when changing them, keep all in sync)

- Variable symbol compared **normalized**: trim + strip leading zeros on both the
  transaction VS and the invoice VS (`0001234` == `1234`).
- Amount tolerance is `0.5` CZK ("na haléře"); beyond that → `amount_mismatch`.
- Only `issued`/`sent` invoices are payable; `paid` candidates surface as
  `already_paid`, no VS / no candidate → `unmatched`, >1 payable with no single
  amount hit → `ambiguous` (admin picks).
- Confirm dedupes by `invoiceId`, locks each row `FOR UPDATE`, and **skips**
  (not fails) non-payable rows, returning them in `skipped[]`.

## Audit middleware interaction

`/billing/bank-statements/` is in the audit `SKIP_PREFIXES`: parse is read-only
with a huge base64 body, and confirm writes its own per-invoice audit entries
(same column shape as `cancelInvoice`). Don't let the generic auto-auditor also
log these.
