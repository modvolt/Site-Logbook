# FÁZE 8.8 – provozní runbook ochrany uploadů

Tento runbook popisuje lokálně připravený řez R04. Nic z něj nebylo nasazeno do produkce a nebyla použita produkční databáze, secrets ani `modvoltapp.cz`.

## 1. Ochranné vrstvy

Pořadí zpracování je záměrný bezpečnostní invariant:

1. reverse proxy přijme API request s vypnutým request bufferingem a s 30s body timeoutem;
2. server vyhodnotí autentizaci a route permission ještě před nákladným JSON/raw parserem;
3. centrální parser vybere limit podle přesné method/path politiky;
4. raw upload route ověří povolený MIME typ, skutečnou strukturu souboru a ZIP budget;
5. Office obsah projde externím scanner hookem; při jeho nedostupnosti se fail-closed odmítne nebo uloží do nepřístupné karantény;
6. object provider dostane SHA-256 a upload status v metadatech;
7. generický upload má durable záznam v `object_uploads`; doménová reference jej smí atomicky claimnout jen stejnému uživateli a jen ve stavu `stored`.

## 2. Limity

| Vstup | Limit / kontrola |
|---|---|
| běžné authenticated/public JSON | 1 MiB |
| URL-encoded body | 256 KiB |
| explicitní velké JSON POST routy pro PDF/base64 nebo bankovní parse | 32 MiB |
| běžný raw dokument/objekt | 25 MiB |
| switchboard vstupy | zachované route limity 20/30 MiB |
| podpisový PNG | dekódovaný vstup 500 KiB, nejvýše 2048 × 2048 a 2 miliony pixelů; výstup se znovu kóduje |
| běžný ZIP | vstup 25 MiB, 50 entries, 25 MiB/entry, 64 MiB rozbaleně, poměr 100:1 |
| OOXML | stejné byte/ratio limity, nejvýše 2000 entries; blokované macros, ActiveX, embeddings a XML signatures |
| ISDOCX | vstup 10 MiB, 10 entries, 20 MiB rozbaleně, poměr 100:1 |
| Gmail/IMAP příloha | 25 MiB/příloha; IMAP nejvýše 20 podporovaných příloh a 64 MiB na zprávu |
| scanner odpověď | 8 KiB, timeout 10 s |

Strukturální validace je fail-closed. Neznámý MIME typ nemá implicitní fallback. PNG, JPEG, GIF, WebP, PDF a ZIP musí mít platný konec bez připojeného polyglot payloadu. Gmail Base64URL musí být kanonické a jeho deklarovaná velikost se musí shodovat s dekódovaným obsahem.

## 3. Scanner

- `UPLOAD_SCANNER_URL` – endpoint přijímající raw `application/octet-stream`; v produkci musí být HTTPS.
- `UPLOAD_SCANNER_TOKEN` – volitelný bearer token.
- očekávaná odpověď: `{"verdict":"clean"}` nebo `{"verdict":"malicious"}`.

Bez scanneru jsou pasivní strukturálně validované formáty přijaty jako `content_validated`. Office formáty jsou fail-closed. Generický Office upload se může uložit pod `/objects/quarantine/…`, ale klient nedostane použitelnou cestu a ledger jej označí `quarantined`. Přímý zákaznický dokument ani e-mailový Office import se bez čistého výsledku nestanou doménovým dokumentem. Přechodná nedostupnost scanneru u e-mailového importu zůstává retryable; škodlivý nebo strukturálně neplatný obsah se nepřijme.

## 4. Databáze a rollout

Migrace `0098_object-upload-ledger` přidává tabulku `object_uploads` se stavy `pending`, `stored`, `claimed`, `quarantined`, `failed`, `delete_pending` a `deleted`. Jde o aditivní expand migraci. Down skript se zablokuje, jakmile tabulka obsahuje jediný evidenční záznam.

Bezpečné pořadí případného produkčního nasazení:

1. záloha a read-only preflight DB/object storage;
2. aplikovat `0098` a ověřit migration parity;
3. nakonfigurovat a samostatně ověřit scanner, pokud mají být přijímány Office soubory;
4. nasadit API a reverse-proxy konfiguraci jako jeden řízený rollout;
5. ověřit malý pasivní upload, následný atomický claim a odmítnutí cizího/již claimnutého objektu;
6. sledovat 413/415, `upload_quarantined`, scanner unavailable, stáří `pending/stored` záznamů a růst quarantine prefixu.

Staré `/objects/uploads/…` cesty zůstávají kompatibilní a v této fázi se nebackfillují ani nemažou. Nové ledgerované uploady používají `/objects/uploads/v2/…`. Inventura, bezpečný reconciler, retence a mazání orphanů patří do R12; stavová evidence z R04 je jejich vstup.

## 5. Návrat

Při rollbacku nejdříve zastavit nové uploady nebo vrátit aplikační/proxy kód. Tabulku `object_uploads` ponechat pro forenzní evidenci. Down migraci použít pouze na prokazatelně prázdné tabulce. Karanténu ani staré objekty automaticky nemazat; vyhodnotit je podle ledgeru a inventury. Pokud se vrací pouze API, zachovat kompatibilitu klientů s legacy cestami a neoznačovat dosud neověřené objekty jako čisté.
