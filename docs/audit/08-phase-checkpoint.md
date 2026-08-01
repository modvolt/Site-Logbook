# Checkpoint FÁZE 8.2 – dokončení R01

- **Stav:** FÁZE 8.2 dokončena; R01 je lokálně dokončeno. R02 ani FÁZE 9 nebyly zahájeny.
- **Výchozí revize:** `ee605e6` (`main`; lokálně sedm commitů před `origin/main`).
- **Výsledná implementační revize:** `bf18843` (`main`); dokumentační checkpoint je následný samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, secrets ani externí provider; nic nebylo pushnuto ani nasazeno.

## 1. Problém, návrh a hranice změny

FÁZE 8.1 mazala sessions při změně hesla nebo deaktivaci. Request, který session načetl těsně před revokací, ji však mohl po smazání znovu uložit. Samotné mazání řádků proto nebylo dostatečným důkazem globálního odvolání.

Zvolené řešení přidává uživateli monotónní `session_generation`:

1. přihlášení uloží aktuální generaci do session;
2. změna hesla, deaktivace, servisní reset a hromadná revokace zvýší generaci ve stejné transakci jako smazání sessions;
3. `attachAuth` porovná session s aktuálním uživatelem a starou nebo bezverzní session zničí a odstraní cookie;
4. při odvolání ostatních vlastních sessions se současné session zapíše nová generace před odpovědí.

Tím se po dokončení již běžícího requestu znovuuložená stará session při příštím požadavku odmítne. Request autorizovaný ještě před revokací nelze bez distribuovaného per-request locku zastavit uprostřed provádění; nová ochrana řeší jeho následnou použitelnost.

## 2. Logické commity

| Commit | Změna | Návrat |
|---|---|---|
| `b5ef912` | aditivní migrace `0096`, session generation v login/middleware a atomické zvýšení při globální revokaci | preferovaný návrat je revert aplikace a ponechání nevyužitého sloupce; DOWN je povolen jen dokud žádná generace nepřekročila 1 |
| `bf18843` | fail-closed izolovaný DB runner a čtyři skutečné API/session scénáře | revert testovacího commitu nemá datový dopad |

## 3. Migrace, rollout a rollback

- `0096_daffy_puppet_master.sql` pouze přidá `users.session_generation integer DEFAULT 1 NOT NULL`.
- Neprovádí mazání ani samostatný backfill; konstanta zachová existující uživatele.
- První nasazení nové aplikace záměrně odmítne existující sessions bez generace. Uživatelé se jednou znovu přihlásí.
- Preferovaný rollback je vrátit aplikační commit a sloupec ponechat. Starší aplikace jej ignoruje.
- Destruktivní DOWN je chráněn: pokud některá generace již vzrostla nad 1, skončí chybou, protože odstranění epochy by mohlo znovu připustit starou session.
- Pro více souběžných API instancí je třeba nejprve aplikovat migraci, následně v krátkém okně vyměnit všechny instance. Smíšené staré a nové instance mohou dočasně způsobovat opakované odhlášení.

## 4. Provedené kontroly

### Izolovaný PostgreSQL 18

Byl vytvořen jednorázový cluster v systémovém temp adresáři, naslouchající pouze na `127.0.0.1` na dočasném portu. Nepoužil běžící lokální službu ani projektovou/produkční DB. Po testu byla dočasná DB odstraněna, server zastaven a celý temp adresář smazán.

- fresh migration chain včetně `0096`: prošel;
- migrace vpřed → chráněný DOWN → opět vpřed: prošla;
- rollback po skutečném zvýšení generace: správně zablokován;
- paralelní prvotní setup: právě jeden výsledek `201`, druhý `409`;
- rotace anonymní cookie na přihlášenou: původní SID odstraněno, nové SID odlišné;
- změna hesla se dvěma skutečnými supertest agents: obě staré sessions odvolány;
- ručně znovuvložený starý session řádek: middleware jej odmítl a zničil;
- odvolání ostatních vlastních sessions: aktuální session zůstala platná s novou generací;
- cílená DB sada: 1 soubor, 4/4 testů.

### Hermetická release brána

Závěrečný `pnpm gate:release` nad `bf18843` prošel bez DB a provider secretů:

- všechny TypeScript typechecky: prošly;
- guard prostředí: 5/5;
- frontend: 78/78;
- `live-events`: 15/15;
- API hermetická sada: 22 souborů, 133/133;
- API production build: prošel;
- PWA production build a service worker: prošly;
- zůstává známé neblokující upozornění na velké Vite chunky (`index` přibližně 824 kB, HEIC přibližně 1,35 MB).

Záměrně nebyla spuštěna produkční migrace, recovery CLI, produkční smoke, externí služby ani vzdálený GitHub Actions workflow.

## 5. Výsledek R01 a neuzavřené otázky

R01 je z pohledu lokální implementace a izolovaného důkazu dokončeno: otázková obnova je odstraněna, servisní recovery je administrátorem řízené, session IDs se při autentizaci rotují, prvotní setup je serializovaný a globální revoke je chráněný generací.

Před produkčním rolloutem zůstává provozní rozhodnutí, nikoli další implementace R01:

1. naplánovat jednorázové odhlášení uživatelů a oznámit odstranění self-service obnovy;
2. ověřit serverový recovery účet/postup a organizační kontrolu operátora;
3. připravit monitoring nárůstu 401 a neúspěšných loginů;
4. aplikovat `0096` před spuštěním nové aplikace a nemíchat dlouhodobě staré a nové instance;
5. po nasazení neprovádět DOWN, pokud již některá generace vzrostla; použít aplikační rollback nebo forward-fix.

Dormantní tabulka `security_questions` a historická data zůstávají beze změny pro pozdější retenční rozhodnutí. R02 a další P0 nálezy zůstávají neopravené.

## 6. Checkpoint a doporučení pro další spuštění

- **další fáze:** FÁZE 8.3 – R02, fail-closed autorizace a objektové vlastnictví; nejprve znovu ověřit negativní matici ze security auditu a rozdělit změnu na malé authorization slices.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** R02 zasahuje centrální permission middleware, deny override, vlastnictví souborů a interní routy. Chyba může otevřít IDOR nebo naopak zablokovat oprávněné pracovní workflow.
- **očekávané činnosti:** zmapovat všechny chráněné routy proti aktuální permission matici; doplnit fail-closed výchozí stav a negativní 401/403/wrong-owner testy; izolovaně opravit první nejrizikovější slice a vytvořit samostatný checkpoint, pokud R02 přesáhne rozumný rozsah.
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/middlewares/permissions.ts`, vybrané storage/download/internal routy, `lib/db/src/permissions.ts`, cílené authorization testy, centrální roadmapa a tento checkpoint.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Fail-closed změny mohou způsobit plošné 403; objektové vlastnictví může vyžadovat aditivní owner metadata a backfill. Každá případná migrace musí mít izolovaný test, měření nevyplněných vlastníků a samostatný rollout/rollback bod.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**. FÁZI 9 nezačínej, dokud nejsou dokončeny schválené implementační vlny FÁZE 8.
