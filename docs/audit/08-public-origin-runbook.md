# Runbook FÁZE 8.10 – důvěryhodný veřejný origin

Tento dokument popisuje lokálně implementovanou hranici SEC-18. Nejde o záznam produkčního nasazení. V této fázi nebyla čtena ani měněna produkční konfigurace, databáze, secrets nebo `modvoltapp.cz`.

## 1. Bezpečnostní invariant

Externí odkazy nesoucí bearer token se nikdy neskládají z request hlaviček `Host`, `X-Forwarded-Host` ani z `req.protocol`. Jediným zdrojem veřejného originu je `PUBLIC_APP_URL`, který API parsuje jako samostatný HTTP(S) origin bez credentials, cesty, query nebo fragmentu. V `NODE_ENV=production` je povoleno pouze HTTPS.

Hranice se vztahuje na:

- podpisové odkazy zakázek;
- potvrzení výdeje OOPP;
- sdílení cenových nabídek;
- veřejné QR odkazy rozvaděčů včetně štítků a protokolů.

Produkční API validuje origin při startu. Chybějící nebo nebezpečný origin proces zastaví; chyba během neprodukčního requestu skončí bezpečnou `503 public_origin_unavailable` bez vrácení interního detailu. Operace, které by uložily nový token nebo založily protokol, validují origin před trvalým vedlejším efektem.

Webový nginx má první `default_server` se `server_name _` a `return 444`. Aplikační server přijímá pouze `NGINX_SERVER_NAME` a loopback názvy potřebné pro lokální healthcheck. To doplňuje, ale nenahrazuje allowlist hostů a firewall na vnějším reverse proxy.

## 2. Povinná produkční konfigurace

Před nasazením nastavit současně:

```dotenv
PUBLIC_APP_URL=https://modvoltapp.cz
NGINX_SERVER_NAME=modvoltapp.cz
```

Pokud se skutečně používá i `www`, musí být rozhodnutí explicitní. Buď má proxy přesměrovat `www` na kanonický host, nebo lze nginx allowlist rozšířit:

```dotenv
PUBLIC_APP_URL=https://modvoltapp.cz
NGINX_SERVER_NAME=modvoltapp.cz www.modvoltapp.cz
```

`PUBLIC_APP_URL` nesmí obsahovat cestu, query, fragment ani přihlašovací údaje. Koncové `/` je přijato a normalizováno. `NGINX_SERVER_NAME` obsahuje pouze nginx hostname tokeny oddělené mezerou, ne schéma ani cestu.

## 3. Přednasazovací kontrola

1. Potvrdit kanonický veřejný hostname a případné přesměrování `www`.
2. Nastavit oba environment parametry na API/web službě před startem nové verze.
3. Bez výpisu interpolované konfigurace spustit `docker compose config -q`.
4. Ověřit, že vygenerovaný nginx config obsahuje samostatný default server s `return 444` a aplikační server s přesným host allowlistem.
5. Potvrdit, že reverse proxy předává původní Host a že healthcheck používá `localhost` nebo `127.0.0.1`.

Abort podmínky:

- API nenastartuje s `public_origin_invalid`;
- platný veřejný hostname končí `444`;
- libovolný generovaný odkaz obsahuje jiný origin než `PUBLIC_APP_URL`;
- neznámý Host se dostane k aplikaci přes veřejný edge;
- proxy vynucuje jiné veřejné schéma/hostname, než je kanonická konfigurace.

## 4. Canary ověření po nasazení

Použít pouze testovací záznamy a testovací příjemce:

1. přes platný hostname ověřit `/api/healthz` a přihlášení;
2. poslat request s neznámým `Host` přímo na web edge a potvrdit uzavření spojení / nginx `444`;
3. vytvořit podpisový odkaz zakázky, potvrzení OOPP, testovací sdílení nabídky a QR náhled;
4. u všech výstupů potvrdit přesný origin `PUBLIC_APP_URL` a nepřítomnost requestem podvrženého hostname;
5. zkontrolovat logy na `public_origin_unavailable`, `public_origin_invalid` a nečekané `503`;
6. potvrdit, že platné odkazy vzniklé před deployem jsou stále routovatelné. Tato podfáze jejich tokenový formát ani data nemění.

Nevypisovat celé bearer URL do ticketu, chatu nebo dlouhodobého logu. Pro důkaz stačí typ toku, čas, očekávaný origin a redigovaný prefix tokenu.

## 5. Návratový postup

Tato změna nemá databázovou migraci ani backfill. Bezpečný návrat je roll-forward oprava konfigurace:

- při chybě originu opravit `PUBLIC_APP_URL` a restartovat pouze API;
- při chybě host allowlistu opravit `NGINX_SERVER_NAME` a restartovat pouze web edge;
- zachovat obě proměnné i při dočasném návratu aplikace na starší image.

Rollback kódu je technicky možný bez změny schématu, ale znovu otevře Host-header poisoning. Nesmí být standardním řešením chybné konfigurace. Pokud je rollback nevyhnutelný, veřejné vytváření a odesílání bearer odkazů má být do obnovení opravy provozně blokováno.

## 6. Co tato podfáze neřeší

FÁZE 8.10 uzavírá pouze SEC-18. Nezavádí společnou tokenovou tabulku, hash-only uložení, jednotnou expiraci/revokaci, one-time consume, atomickou quote transition ani neměnné podepisované job/quote snapshoty. Tyto části SEC-12, SEC-14, GDPR-11, COMP-02, COMP-07 a UX-09 zůstávají pro další podfáze R06.

Loopback názvy jsou záměrně povoleny uvnitř nginx kontejneru pro healthcheck. Veřejné vystavení interního portu, pravidla vnějšího reverse proxy a síťový firewall musí být ověřeny samostatně; kanonický origin neřeší přímý síťový bypass edge vrstvy.
