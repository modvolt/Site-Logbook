# R13-D9QT – přesný aktivní transfer preflight

> **Nahrazeno opravným checkpointem `17-ak-r13-d9qt-active-transfer-correction.md`.**
> Tento dokument správně identifikoval první 24cestovou část, ale nesprávně ji
> označil za celý D9QT transfer. První část byla přenesena s exact-SHA kontrolou;
> dalších 24 integračních cest čeká na samostatné opravené schválení.

Datum: 2026-08-11  
Aktivní HEAD: `df918a5bbfb786420eba6c48844b632ba139d203`  
Aktivní větev: `agent/phase16c3-staging-preflight`  
Stav: **read-only preflight; žádný produkční kód, index, commit ani ref nebyl změněn**

## Výsledek

Aktivní worktree byl zachycen přes oddělený alternativní index jako strom
`6ccd498c32a216855970d2c687a702ec103f5214`. Zmrazený D9QT strom je
`9a8581bf1e65b230a5f31493c5241de61fdc5487`.

Oba stromy mají 414 položek. Porovnání univerzálních Git blob SHA přes oba
oddělené repozitáře dokládá:

- 390 položek je byte-for-byte shodných;
- 20 existujících položek má přesně známou D9QT náhradu;
- 2 staré neprodukční rollbacky jsou pouze v aktivním stromu a mají být odstraněny;
- 2 přejmenované rollbacky jsou pouze v D9QT a mají být přidány;
- rozdíl je omezen výhradně na migration lineage, rollbacky a čtyři navazující DB source/test soubory;
- D9QT neobsahuje migraci `0106`; `0100` zůstává vyloučená.

Hlavní aktivní index měl před i po preflightu SHA-256
`89c13526075ef496ca49cd72c41e676566a9a4853a8cdfe33bd695562b487589`.

## Přesný manifest 20 náhrad

Formát: `cesta — aktivní blob -> schválený D9QT blob`.

- `lib/db/migrations/meta/0096_snapshot.json` — `ef8bfdef584ac90ac6380e77c6c15eeaea44733b` -> `c2a8f486533a4a6264ae0e9c10e37a198bd9b592`
- `lib/db/migrations/meta/0097_snapshot.json` — `e6e00aa523f06acfff44ee2f3faff02a9f10e27b` -> `9a215358647df2b5aaf12a0c64cd23aa71c9fae0`
- `lib/db/migrations/meta/0098_snapshot.json` — `57e2170b1a4c82706d835b1be5f987a19c59f831` -> `8ec53aaa85845deec49f34a763272046b41d2cdb`
- `lib/db/migrations/meta/0099_snapshot.json` — `81bfb2d3a06ee1c393950a4c17aa7b94f233ac4e` -> `6b62b22d90ffead9f8461ca9b3bd8ccddad3857c`
- `lib/db/migrations/meta/0101_snapshot.json` — `4416106ceeeddfffebbe65d849a6699d6b1a1b3e` -> `79edf3b70692075e210ec4b461e5c899335e056c`
- `lib/db/migrations/meta/0102_snapshot.json` — `6aa6a94f90f13a88d342780a4cabc492ab9eb809` -> `8c5d44d036304b724dcedf5f3c342c79bac84818`
- `lib/db/migrations/meta/0103_snapshot.json` — `4334b26b0ea88a2b17a3ec0522b78530f35cc63f` -> `64cf4cecb4cc16403c4553a936b264eec3d2b41f`
- `lib/db/migrations/meta/0104_snapshot.json` — `6cddb53d716c57469c3be53116e16693091485af` -> `248b5ea4b294ee0931b7487e0e47292ef7435aa8`
- `lib/db/migrations/meta/0105_snapshot.json` — `99bb67acdd263e8814577848b76b8af344d27a18` -> `70a38fa8063c8eee44a61c085bf90a3319987bac`
- `lib/db/migrations/meta/_journal.json` — `abb26f366c09634566ddc0823fd03f588ca01987` -> `b99c8c107f14d5c3053a142bd6f44ddfc399b471`
- `lib/db/rollbacks/0098_object-upload-ledger.down.sql` — `b3193ed106550ca28b91b1d414bae4ca8dfaf2e6` -> `9a40406e3fedc2fc6c048cc06f3e8c5a17b4a228`
- `lib/db/rollbacks/0099_secret_envelope_encryption.down.sql` — `5ed6289521716002ff4dba2d02b6b5438791c909` -> `d90cc5ccb8dee2069fdaedc2de8b175da1af9843`
- `lib/db/rollbacks/0101_public_access_token_lifecycle.down.sql` — `4359f0a7ba70a4cf3378c88a2e8c051b5f5b5edc` -> `bf9f4da3180a8eb2a55d81e07ac059001206530a`
- `lib/db/rollbacks/0102_immutable_job_quote_versions.down.sql` — `5cdfc500493a79f3191e7dd113fcf71893b519c9` -> `34dbbdbeb7d745d746c360308b18fb60b717f55f`
- `lib/db/rollbacks/0104_thin_sheva_callister.down.sql` — `47e82a43707b681751ad58f9bf8ff89ff088bca1` -> `b2458b9f71a62b1ba2febd222932e09fb9211f91`
- `lib/db/rollbacks/0105_smooth_nitro.down.sql` — `e79070eb95f36b1cc9271bc6e6b75e53c37561d8` -> `4c531c6b2438212006f49aacbd3cae7338c0fe87`
- `lib/db/src/external-schema-preflight.ts` — `faaa112c881b60eb24226033dc22fe8a7c2c2baf` -> `8087be3293406323f38e0f5d4c79b31a74fc9279`
- `lib/db/src/schema/document-versions.ts` — `8a41e0c2558d491437809d7cc1a2918c149f23e6` -> `4d1e2ff39a982da3f94bf11972b7b725d5b473b0`
- `lib/db/src/schema/quotes.ts` — `0a4a7cdd4919e962de793348842eda3a8a222f00` -> `07144576a89c5882eb97652d89bdff2b9bce4caf`
- `lib/db/src/test-auth-session-db-suite.ts` — `238d337b72857a1066c74af80a39bc214167fd6` -> `ef83c11ed98ac1e5034dd8fba9990b7bf2fc4334`

## Dvě přesná odstranění

- `lib/db/rollbacks/0096_daffy_puppet_master.down.sql` — současný blob `b54ca856c836d7dde17b0ad6fd60ab8fd53a96bb`;
- `lib/db/rollbacks/0097_api_idempotency_records.down.sql` — současný blob `75cb4d0b3edd3c0af621f37883e95bc1cb32c33c`.

Jde pouze o dosud neprodukční code artifacts nahrazené aktuálními názvy. Produkční opaque journal identity se tím nepřejmenovávají ani nemažou.

## Dvě přesná přidání

- `lib/db/rollbacks/0096_far_smiling_tiger.down.sql` — D9QT blob `cdc4ee129c154bb81d4e328f5696039ff044228f`;
- `lib/db/rollbacks/0097_session_and_api_idempotency.down.sql` — D9QT blob `2e36818c02f457d070dc2bfe5cb3714ee3c463a1`.

## Fail-closed přenosový postup

Před budoucím zápisem znovu ověřit všech 24 současných stavů proti tomuto manifestu. Jakákoli neshoda znamená stop a nový review; nic automaticky nemergovat.

Po výslovném schválení lze mechanicky přenést pouze uvedených 24 cest z přesného D9QT stromu. Bezprostředně poté musí platit:

1. všech 414 blobů aktivního worktree je shodných s D9QT;
2. aktivní index stále není automaticky stageovaný;
3. `0106` ani `0100` nejsou přítomné;
4. migration journal má přesně 105 známých položek a tail `0105_smooth_nitro`;
5. cílené lineage, quote, auth, DB a combined rehearsal testy jsou zelené;
6. commit, push, deploy a spuštění migrací zůstávají samostatné approval boundary.

Tento preflight nic neopravňuje měnit bez výslovného souhlasu uživatele.
