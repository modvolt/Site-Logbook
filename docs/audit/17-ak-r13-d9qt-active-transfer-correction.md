# R13-D9QT – oprava aktivního transfer checkpointu

> **Dokončeno checkpointem `17-al-r13-d9qt-active-transfer-complete.md`.**
> Zbývajících 24 cest bylo po samostatném schválení přeneseno a celý 49položkový
> D9QR integrační rozsah byl ověřen bez odchylky.

Datum: 2026-08-11  
Aktivní HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`  
D9QT strom: `9a8581bf1e65b230a5f31493c5241de61fdc5487`  
Stav: **první přesně schválená 24cestová část přenesena; druhá 24cestová část čeká na opravené schválení**

## Oprava předchozího tvrzení

Checkpoint `17-aj` nesprávně popsal 414 položek jako celý D9QT strom. Přesný Git strom D9QT má 1664 položek. Číslo 414 pocházelo z omezené mezimnožiny porovnání a nemohlo dokazovat úplnou shodu.

Schválený první přenos přesto zůstal bezpečný: všech 24 jeho vstupních a výstupních blob SHA bylo před zápisem fail-closed ověřeno proti zmrazenému D9QT stromu. Bylo přeneseno 20 náhrad, odstraněny dva staré rollbacky a přidány dva nové rollbacky. Hlavní Git index zůstal přesně `89c13526075ef496ca49cd72c41e676566a9a4853a8cdfe33bd695562b487589` a nic nebylo stageováno.

Úplný integrační rozsah D9QR uvnitř D9QT má 48 cest. Po první části zbývá přesně dalších 24 relevantních cest. Nesouvisející fyzický drift pod `attached_assets/` není součástí integračního transferu a nesmí být přepisován.

## Osm přesných přidání

Formát: `cesta` — D9QT blob.

- `artifacts/api-server/src/lib/quote-calculations.ts` — `50df447d10a7b534b517ce3c584ff059c25b49f3`
- `artifacts/api-server/test/migration-lineage-integration.contract.test.ts` — `93ecce5e44e845e5cbd04140be9146a4c3323e90`
- `artifacts/api-server/test/quote-calculations.test.ts` — `fd7259be9a73256b3cfbcb39150efd1a42df2dd9`
- `artifacts/api-server/test/quote-margin-contract.test.ts` — `cc89381791d205d3ee68a843bd38ce720628045d`
- `artifacts/stavba/src/lib/quote-calculations.ts` — `a89cb1ab54346f130f4af9c055a2c24a916c35da`
- `artifacts/stavba/test/quote-calculations.test.ts` — `d3f54997f2664369b68d5853dd85abdcf3081103`
- `lib/db/migrations/0096_far_smiling_tiger.sql` — `03ba73d5cc38f290d58f561683cef52fa1404241`
- `lib/db/migrations/0097_session_and_api_idempotency.sql` — `f2425b38701829e772e4ad87534acdeac0fb7170`

## Čtrnáct přesných náhrad

Formát: `cesta` — současný aktivní blob -> D9QT blob.

- `artifacts/api-server/src/lib/quote-pdf.ts` — `532e7c5151ce078ae0fd21c52d328bfb1216d4f4` -> `9bc1eb61ec06f73a303f20be0613b0fc7eba6ec4`
- `artifacts/api-server/src/lib/quote-service.ts` — `18818b05f201b187828d91ce8015b84407d5c4c0` -> `29aa57ad476ef233cdb71a978053d7e3f4ac3484`
- `artifacts/api-server/src/lib/quote-version-service.ts` — `6f2d91dbc7d4e489f775fd1d7908f01ed4ab3a86` -> `db6321776cf4c17be8a0dc493dce393a1b04a506`
- `artifacts/api-server/src/routes/quotes.ts` — `b081aa6255b85e4de9c7ee6678de54fa089471a8` -> `07e87dc295102643a9fddbca7fc04cf9878fd9da`
- `artifacts/api-server/test/document-version-immutability.db.test.ts` — `6a1151b341872cb65635be47bf3f65e764688bf7` -> `02a11141ad756f14fc4cbc025d05ed37856ca07f`
- `artifacts/api-server/test/external-accounts-migration.contract.test.ts` — `243dba3e041e97adf70530e092eb83eb7024b6c2` -> `f18aca3f200a5a272805097634931f3aa03d4767`
- `artifacts/api-server/test/public-access-token.contract.test.ts` — `0ab2e73d4fcc09b1526a26712ea3a1aedb322ac7` -> `5e44c606aa859409f595160009a0eb7a4dfa8b12`
- `artifacts/api-server/test/public-access-token.db.test.ts` — `a27f26ed6067f5abbb7558301f079c3fec15d75a` -> `f06feb11e6fc4d520c4d903dd795048c36b33f8d`
- `artifacts/api-server/test/public-access-token-ownership-migration.contract.test.ts` — `1ea1817dfa91380364cd2c74c32df70a6c82546a` -> `38cf0abc54590ee701d9d7500526e0df69576704`
- `artifacts/stavba/src/pages/quote-detail.tsx` — `c5b35f49650bd7bb1647da3eeda48d35ec94292b` -> `72d03dbe4edaa72fda79be94cc360234d1c914e3`
- `artifacts/stavba/src/pages/quote-share.tsx` — `5871e784956fb606c8e8ecd99b18b8e21a8cfbad` -> `68ae5e4e7df316cf7dc3a89d132d55d3736092ca`
- `lib/api-client-react/src/generated/api.schemas.ts` — `6c02631144091e969b6bd5e69b0f70f6b22f0a34` -> `9666392f46d94fc1111fd47d1101bde0baa842c3`
- `lib/api-spec/openapi.yaml` — `a09e5b69a8df74f202035064a218fa596e337765` -> `76980563dbdd7aa2eefe319c645e5d1dc6b7fc95`
- `lib/api-zod/src/generated/api.ts` — `52ef5a24e6834bfeaee4530be7634e7ed5f02ab4` -> `409f4e91c142d7fa611162be78bcc44174ae828d`

Soubor `lib/api-client-react/src/generated/api.ts` už je v aktivním worktree byte-shodný s kombinovaným D9QT výsledkem a nesmí se znovu měnit.

## Dvě přesná odstranění

- `lib/db/migrations/0096_daffy_puppet_master.sql` — současný blob `f124ab1bbb669d3db7c964978d9452a1ed36e287`
- `lib/db/migrations/0097_api_idempotency_records.sql` — současný blob `06a71c2dfe8044467dd48fe9588791a5f6deb3f8`

Jde o neprodukční konfliktní code artifacts. Produkční `0096_far_smiling_tiger` se přidává byte-exact a `0100` zůstává vyloučena.

## Další fail-closed krok

Před zápisem se musí znovu ověřit všech 24 současných stavů proti tomuto manifestu. Po přenosu musí být všech 48 D9QR integračních cest shodných s D9QT, journal musí mít 105 položek s tail `0105_smooth_nitro`, `0100` ani `0106` nesmí být přítomné a musí projít cílené quote, lineage, auth, OpenAPI, typecheck a disposable DB testy.

Commit, push, private repin/merge, workflow dispatch, GHCR zápis, deploy a spuštění migrací zůstávají samostatné approval boundary.
