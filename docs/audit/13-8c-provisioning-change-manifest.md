# FÁZE 13.8C – autorizovatelný staging provisioning change manifest

Tento dokument je **plán změn, nikoli autorizace k jejich provedení**. Nevytvořil žádný
resource, bucket, credential, DNS záznam ani secret. Každý níže uvedený mutation gate
vyžaduje nové výslovné schválení uživatele.

Centrální živá evidence a ID nálezů jsou v
[13-8c-external-capability-preflight.md](13-8c-external-capability-preflight.md).

## 1. Povinné rozhodovací vstupy před provisioningem

| Vstup                    | Požadovaný stav                                                                                                         | Aktuální stav                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| storage provider         | default encryption + private/public-access kontrola + versioning + Object Lock/retention musí projít strict preflightem | `DECISION_REQUIRED`; Hetzner bez SSE-C adaptace nesplní default-encryption důkaz |
| tenant/project isolation | staging key nesmí mít žádný přístup k produkčním bucketům                                                               | `BLOCKED`; nový key ve stejném Hetzner projektu není sám o sobě dostatečný       |
| staging origin           | user-owned HTTPS origin mimo `modvoltapp.cz` a jeho subdomény                                                           | `BLOCKED`; server wildcard domain je prázdný                                     |
| host capacity            | CPU, RAM, disk a build headroom doložené před prvním buildem                                                            | `BLOCKED`; server metrics vypnuté                                                |
| resource limits          | explicitní CPU/RAM limit pro celý staging resource                                                                      | `BLOCKED`; hodnoty nejsou schválené                                              |
| production drift         | redigovaný obsah jedné neaplikované změny známý; žádný rebuild                                                          | `BLOCKED`; `View changes` zatím neautorizováno                                   |
| PPE freshness            | samostatný počet dní pro `ppe_signature` a `ppe_confirmation`                                                           | `PENDING_OWNER`                                                                  |
| image policy             | rozhodnutí o digest pinningu Node/Nginx/PostgreSQL                                                                      | `PENDING_OWNER`                                                                  |

## 2. Navržená nová identita

Pro lepší lidskou i konfigurační hranici nepoužívat `Clone` produkce. Vytvořit resource
z repozitáře od začátku:

| Objekt          | Navržená hodnota                                                          |
| --------------- | ------------------------------------------------------------------------- |
| Coolify project | `Site Logbook staging` – nový project, ne produkční project               |
| environment     | `staging`                                                                 |
| resource        | `Modvolt staging`                                                         |
| server          | `localhost`, pouze po capacity gate a schválení sdíleného failure domainu |
| repository      | `modvolt/Site-Logbook`                                                    |
| branch          | `agent/phase13-staging-gate`                                              |
| exact commit    | `7f4bd719c951dffd58f7697253156c3cb7146b23`                                |
| build pack      | Docker Compose                                                            |
| base directory  | `/`                                                                       |
| compose file    | `/docker-compose.staging.yml`                                             |
| domain          | pouze služba `web:80`; hodnota `PENDING_OWNER`                            |

## 3. Povinné Coolify přepínače

- `Auto Deploy`: **off**;
- `Preview Deployments`: **off**;
- `Include Source Commit in Build`: **on**;
- `Raw Compose Deployment`: **off**;
- `Connect to Predefined Network`: **off**;
- `Force HTTPS`: **on**;
- žádná domain ani host port pro `postgres`, `mailpit`, `api` nebo preflight;
- resource CPU/RAM limity vyplnit před prvním buildem;
- nevkládat production shared variables ani production env reference.

Coolify vytváří per-resource síť. `docker-compose.staging.yml` proto nesmí získat
vlastní network a resource se nesmí připojit k predefined/produkční síti.

## 4. Storage manifest

### Preferovaná strict varianta

Vybrat provider, u kterého existující read-only gate prokáže:

- HTTPS endpoint a explicitní region/path-style;
- nový bucket v namespace `site-logbook-staging-*`;
- privátní bucket a podporovaný public-access block nebo předem schválený ekvivalent;
- default server-side encryption viditelnou přes provider API;
- versioning `Enabled`;
- Object Lock zapnutý už při vytvoření bucketu;
- default retention `GOVERNANCE` s ownerem schváleným počtem dní;
- lifecycle pro neaktuální verze až po cost/retention schválení;
- samostatný key omezený pouze na tento bucket;
- secret-free storage fingerprint schválený před vložením do Coolify.

### Hetzner podmíněná varianta

Hetzner lze zvolit jen pokud samostatná návrhová fáze vyřeší `F13.8C-06` a
`F13.8C-07`:

1. nový Hetzner projekt neobsahující produkční bucket;
2. bucket vytvořený s Object Lock v lokaci `fsn1`;
3. versioning + nenulová default governance retention;
4. explicitní private bucket policy;
5. SSE-C klíčový lifecycle nebo jiný ověřitelný encryption ekvivalent;
6. úprava všech Put/Get/Head/Delete/copy/recovery cest a read-only preflightu;
7. samostatný security review a zelený exact-SHA Quality gate.

Bez těchto bodů se strict gate nesmí změnit na `unknown=pass` ani spustit staging s
nešifrovanými objekty.

## 5. Secret a environment contract

Do Coolify vložit pouze nové staging-only hodnoty. Hodnoty se nesmějí kopírovat do
evidence, shell history, PR ani GitHub comments.

| Scope            | Proměnné                                                            | Coolify flags                          |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------- |
| build identity   | `STAGING_BUILD_SHA`, `VITE_BUILD_SHA` podle Compose kontraktu       | build-time podle potřeby, bez secretu  |
| runtime identity | `STAGING_ENVIRONMENT_ID`, `STAGING_PUBLIC_APP_URL`, Compose project | runtime; veřejná metadata              |
| DB               | `STAGING_POSTGRES_*`                                                | runtime-only                           |
| session/keyrings | session secret a oba staging keyringy                               | runtime-only, nikdy production hodnoty |
| object storage   | všechny `STAGING_S3_*` credentials/bucket hodnoty                   | runtime-only; build-time **off**       |
| SMTP             | pouze interní Mailpit hodnoty z Compose                             | žádný externí relay/recipient          |

Před uložením env spustit manuální kontrolu, že žádný bucket, key, DB URL, session
secret ani keyring fingerprint není shodný s produkcí.

## 6. DNS a HTTPS manifest

Preferovaný origin je nový user-owned domain mimo `modvoltapp.cz` a jeho subdomény:

1. nový `A` záznam na aplikační server;
2. Coolify domain ve formátu `https://...` pouze u služby `web`;
3. validní veřejně důvěryhodný certifikát, žádný self-signed fallback;
4. negativní ověření, že origin není production host a neukazuje na jiný resource;
5. DNS/HTTPS musí být hotové před prvním autentizovaným smoke.

`sslip.io` lze použít pouze s explicitním owner waiverem, časovým omezením a vědomím,
že DNS zónu neovládá uživatel. Nesmí se použít subdoména `modvoltapp.cz`, protože ji
fail-closed release guard odmítá.

## 7. Resource a volume izolace

- nový resource musí mít nový Coolify UUID a novou per-resource síť;
- `staging_pgdata`, `staging_mailtls` a `staging_mailca` nesmějí mapovat existující
  production nebo staré staging volumes;
- před prvním API startem uložit secret-free volume identity/fingerprint;
- Mailpit nemá relay, forwarding ani veřejnou domain;
- žádný `ports:` override a žádná domain pro privátní služby;
- před buildem nastavit konzervativní CPU/RAM limit podle doložené kapacity hostu;
- při nedostatečné kapacitě použít druhý server, ne zvýšit riziko pro produkci.

## 8. Mutation gates a pořadí

### F13.8D – rozhodovací a drift gate, stále bez provisioning změn

1. zvlášť autorizovaně zobrazit a redigovat produkční `View changes`;
2. zvolit provider/encryption model, origin, retention, PPE limity a image policy;
3. získat server capacity evidence a navrhnout resource limits;
4. připravit přesný mutation checklist a rollback; nic neukládat do produkce.

### F13.8E – resource creation only

Pouze po novém schválení vytvořit prázdný staging storage/project/key, nový Coolify
project/environment/resource a DNS. Nevkládat secrets do Git, nespouštět deploy ani
API. Read-only provider preflight musí uložit fingerprint a policy stav.

### F13.8F – secret injection a inert config validation

Pouze po novém schválení vložit staging-only secrets, s vypnutým Auto Deploy. Provést
Compose/preflight validaci bez startu dlouho běžících služeb, pokud to Coolify umožní
bez deploye; jinak tento krok sloučit až s výslovně schváleným deploy gate.

### F13.8G – first exact-SHA deploy a migrace

Tento gate je rizikový. API startup automaticky aplikuje existující migrace na novou
staging DB. Vyžaduje zvláštní schválení, DB snapshot/restore plán, exact-SHA runtime
identity a explicitní potvrzení, že 0100 není v deployovaném stromu.

## 9. Abort a rollback hranice

Okamžitě zastavit, pokud:

- se objeví produkční bucket/key/DB/domain/shared variable;
- storage key může přistupovat k produkčnímu bucketu;
- encryption/public-access/versioning/Object Lock/retention není prokázán;
- server capacity nebo resource limits nejsou známé;
- Coolify chce deploynout `main`, `HEAD` nebo jiné SHA;
- se má použít root `/docker-compose.yml` místo staging Compose;
- se má zapnout Auto Deploy, preview, predefined network nebo host port;
- produkční neaplikovaný diff vyžaduje rebuild bez rollbacku;
- se v migračním stromu objeví 0100.

Před prvním deployem je rollback pouze smazání prázdných staging-only konfigurací.
Po prvním zápisu do Object Lock bucketu nemusí být okamžitý cleanup možný. Po API
startu je rollback omezen stavem staging DB a aplikovanými migracemi; nikdy se nesmí
rollbackovat přes produkční resource nebo produkční data.

## 10. Výslovně zakázané zkratky

- `Clone` produkčního resource;
- znovupoužití production env, keyringu, DB nebo S3 credential;
- stejné Hetzner project-wide credential bez policy důkazu;
- produkční rebuild za účelem „ověření“ stagingu;
- použití globálního Coolify S3 profilu jako aplikačního bucketu;
- změna strict gate na fail-open kvůli provider incompatibilitě;
- merge PR, push na `main`, production deploy nebo migrace 0100.
