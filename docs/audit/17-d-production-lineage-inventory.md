# R17-D – read-only inventura produkční migrační lineage

Datum kontroly: 2026-08-11  
Rozsah: pouze redigované čtení Coolify a produkční tabulky `__drizzle_migrations`; bez čtení secrets, změny produkce, deploye nebo spuštění migrace.

## Výsledek

- Nasazený commit produkčního resource `Modvolt (localhost)` je `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5`.
- Journal na tomto commitu obsahuje 97 položek, od `0000_dark_the_call` po `0096_far_smiling_tiger`.
- Produkční `__drizzle_migrations` obsahuje 99 řádků, 99 různých timestampů a 99 různých hashů.
- Všech 97 timestampů z journalu nasazeného commitu je v produkci. Nechybí žádná očekávaná položka.
- Produkce navíc uchovává dvě historické položky, které nejsou v journalu nasazeného commitu ani v dostupné lokální Git historii:

| `created_at`    | hash                                                               | klasifikace                      |
| --------------- | ------------------------------------------------------------------ | -------------------------------- |
| `1783190993468` | `fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927` | `legacy_production_only_unknown` |
| `1783261969512` | `3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa` | `legacy_production_only_unknown` |

Kontrolní fingerprint produkční tabulky v okamžiku inventury: počet `99`, minimum `1751120000000`, maximum `1786383352759`, agregovaný MD5 `2d13cbf063c8fdef5ecccfbd3afb69b8`.

## Bezpečnostní rozhodnutí

1. Již aplikovaná identita `0096_far_smiling_tiger` se nesmí přejmenovat, přepsat ani nahradit jinou migrací `0096`.
2. Dvě produkční legacy položky se nesmí z tracking tabulky smazat ani zpětně pojmenovat bez doložitelného zdroje. V plánu zůstávají jako explicitně neznámá historie.
3. Lokální větev obsahuje odlišnou `0096_daffy_puppet_master` a další migrace `0097`–`0099`, `0101`–`0105`. Journaly proto nelze sloučit mechanickou volbou jedné verze souboru.
4. Migrace `0100` zůstává nezařazena.
5. Nové číslo migrace R09–R13/R17 se nepřidělí, dokud nebude read-only odvozen exact schema diff produkčního `0096_far_smiling_tiger` proti lokálnímu cílovému schématu a připravený forward-only renumber/rebuild plán.

## Další povolený krok

Bez změny produkce lze připravit lineage reconciliation plan: zachovat produkční 0096, přenést neaplikované lokální změny do nových forward-only migrací nad produkčním koncem, regenerovat snapshot/journal a dokázat preflight na izolované kopii. Integrace `main`, commit/push a jakékoli spuštění migrace jsou samostatné schvalovací hranice.

## Checkpoint

- Produkční data změněna: ne.
- Produkční migrace spuštěna: ne.
- Secrets zobrazeny nebo uloženy: ne.
- Deployed SHA a journal parity: zjištěny.
- Legacy odchylky: dvě, zachovat jako unknown.
