---
name: Apply-warehouse-prices auto-creates missing cards
description: "Aktualizovat ceny" (apply-warehouse-prices) now creates missing warehouse catalogue cards for non-matching material lines instead of skipping them.
---

# Rebill / cost-doc lines that have no warehouse card

`applyWarehouseCatalogAndPriceHistory` (cost-document-service.ts) pushes an approved
cost document's purchase prices into `warehouse_items`. It matches a line to a card by
code (supplierSku/EAN) then by name. Lines with **no** matching card used to be
silently skipped — so rebill ("Přefakturovat") material lines never reached the
warehouse and "Aktualizovat ceny" reported "Aktualizováno 0, přeskočeno N".

Now the no-match branch **auto-creates** a catalogue card.

**Rule:** an auto-created card is catalogue-only — `quantity: "0"` and **no stock
movement is appended**.
**Why:** a rebill / job material is issued to a job, not received into stock; the
warehouse ledger is append-only and `item.quantity = sum(movements)`. Fabricating a
příjem here would corrupt the ledger. The card exists so prices/metadata are tracked;
a later job-material reconcile may draw it negative — that is acceptable (issued-but-
not-received), not a bug to "fix" by inventing stock.

**Gotcha:** after inserting, update the in-memory `byCode`/`byName` maps with the new
card so a second line in the *same* run with the same code/name updates it instead of
inserting a duplicate. There is no DB uniqueness on code/name, so concurrent apply
runs can still theoretically duplicate — acceptable for this admin-only action.

The result type carries a `created` count alongside `updated`/`skipped` (threaded
through the OpenAPI `WarehousePriceUpdateResult` + `matchedBy` enum gains `"created"`);
the UI shows "Aktualizováno X, nově založeno Y, přeskočeno Z" where X =
`updated.length - created`.
