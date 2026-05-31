# Stavba – Job Tracker

Stavba je interní webová aplikace (PWA) pro evidenci zakázek ve stavební firmě
**Modvolt s.r.o.** Umožňuje sledovat zakázky a úkoly, materiál, lidi, zákazníky
(včetně provozoven a kontaktů), trezor přístupových údajů k zařízením, evidenci
odpracovaného času, přehledový dashboard se statistikami, auditní log, výmaz dat
dle GDPR, generování PDF zakázkových listů s odesláním e-mailem zákazníkovi a
automatické zálohování databáze. Uživatelské rozhraní je v češtině a aplikaci
lze nainstalovat jako PWA s offline shellem.

Aplikace je plně kontejnerizovaná a samostatně hostovatelná (bez závislosti na
Replit infrastruktuře).

---

## Architektura

Stack tvoří čtyři služby:

| Služba     | Image / zdroj                     | Účel                                              |
| ---------- | --------------------------------- | ------------------------------------------------- |
| `postgres` | `postgres:16-alpine`              | Aplikační databáze                                |
| `minio`    | `minio/minio`                     | S3-kompatibilní objektové úložiště (přílohy)      |
| `api`      | `artifacts/api-server/Dockerfile` | REST API (Express 5) + migrace DB + zálohy        |
| `web`      | `artifacts/stavba/Dockerfile`     | Statické soubory PWA + reverzní proxy na `/api`   |

Služba **web** (nginx) je jediný veřejný vstupní bod: servíruje sestavenou PWA a
reverzně proxuje `/api/*` na API kontejner, takže prohlížeč komunikuje s jedním
originem (na tom závisí session cookie).

**Technologie:** pnpm workspaces, Node.js 24, TypeScript 5.9, Express 5,
PostgreSQL + Drizzle ORM, Zod, OpenAPI codegen (Orval), Vite + React, esbuild.

---

## Požadavky

**Pro nasazení (doporučeno):**

- Docker + Docker Compose (nebo Coolify)
- Doména s možností nastavit DNS záznamy (kvůli TLS)

**Pro lokální vývoj bez Dockeru:**

- Node.js 24+ a pnpm 9+
- Běžící PostgreSQL 16
- `pg_dump` / `pg_restore` (balík `postgresql-client`) pro funkci záloh
- (volitelně) S3-kompatibilní úložiště pro přílohy a zálohy

---

## Proměnné prostředí

Zkopírujte šablonu a vyplňte tajné hodnoty:

```bash
cp .env.example .env
```

| Proměnná                    | Povinná | Výchozí          | Popis                                                                 |
| --------------------------- | ------- | ---------------- | --------------------------------------------------------------------- |
| `POSTGRES_USER/PASSWORD/DB` | ano\*   | —                | Pro vestavěnou službu `postgres`; sestaví `DATABASE_URL`.             |
| `DATABASE_URL`              | ano     | —                | Connection string PostgreSQL (v Compose se sestaví z výše uvedených). |
| `SESSION_SECRET`            | ano     | —                | Tajný klíč pro podpis session cookie (`openssl rand -hex 32`).        |
| `PORT`                      | ne      | `5000`           | Port, na kterém API naslouchá uvnitř kontejneru.                     |
| `S3_BUCKET`                 | ano     | —                | Název bucketu pro přílohy a zálohy.                                   |
| `S3_ACCESS_KEY_ID`          | ano     | —                | Přístupový klíč (v Compose z `MINIO_ROOT_USER`).                     |
| `S3_SECRET_ACCESS_KEY`      | ano     | —                | Tajný klíč (v Compose z `MINIO_ROOT_PASSWORD`).                      |
| `S3_ENDPOINT`              | ne      | AWS výchozí      | Endpoint, přes který API přistupuje k úložišti (`http://minio:9000` v Compose). |
| `S3_REGION`                 | ne      | `us-east-1`      | Region úložiště.                                                      |
| `S3_FORCE_PATH_STYLE`       | ne      | `false`          | `true` pro MinIO / path-style brány.                                 |
| `S3_PRIVATE_PREFIX`         | ne      | `private`        | Prefix klíčů pro nahrané soubory.                                    |
| `S3_PUBLIC_PREFIX`          | ne      | `public`         | Prefixy pro veřejné assety (oddělené čárkou).                        |
| `BACKUP_ENABLED`            | ne      | `true`           | `false` vypne plánované zálohy (ruční přes UI fungují dál).          |
| `BACKUP_INTERVAL_HOURS`     | ne      | `24`             | Interval plánované zálohy v hodinách.                                |
| `BACKUP_RETENTION`          | ne      | `14`             | Počet nejnovějších úspěšných záloh, které se uchovávají.            |
| `PG_DUMP_PATH`              | ne      | `pg_dump`        | Cesta k binárce `pg_dump`, pokud není v `PATH`.                      |
| `SMTP_HOST`                 | ne      | —                | Prázdné = vypnuté odesílání e-mailů (PDF zakázkové listy).           |
| `SMTP_PORT`                 | ne      | `587`            | Port SMTP serveru.                                                    |
| `SMTP_SECURE`               | ne      | auto             | `true` pro implicitní TLS (port 465).                               |
| `SMTP_USER` / `SMTP_PASSWORD` | ne    | —                | Přihlašovací údaje SMTP (nepovinné u otevřených relay).             |
| `SMTP_FROM`                 | ne      | `SMTP_USER`      | Adresa odesílatele.                                                  |
| `MINIO_ROOT_USER/PASSWORD`  | ano\*   | —                | Přihlašovací údaje vestavěného MinIO (Compose).                     |
| `MINIO_PORT` / `MINIO_CONSOLE_PORT` | ne | `9000` / `9001` | Host porty, na kterých je MinIO publikováno.                         |
| `WEB_PORT`                  | ne      | `8080`           | Host port, na kterém je aplikace dostupná.                           |

\* Povinné při použití vestavěných služeb `postgres` / `minio`. Při použití
spravované databáze nebo externího S3 dodejte přímo `DATABASE_URL` a `S3_*`.

Úplný komentovaný seznam je v [`.env.example`](.env.example).

---

## Lokální spuštění (Docker Compose)

```bash
cp .env.example .env      # poté upravte tajné hodnoty
docker compose up --build
```

Aplikace poběží na <http://localhost:8080>.

Co se stane při startu:

1. `postgres` a `minio` nastartují; jednorázová úloha `createbuckets` vytvoří
   bucket `S3_BUCKET`.
2. `api` nastartuje, **aplikuje všechny čekající SQL migrace** a začne
   naslouchat na portu 5000.
3. `web` (nginx) servíruje PWA na portu 8080 a proxuje `/api` na `api`.

Zastavení a smazání dat: `docker compose down -v`.

Po prvním spuštění otevřete aplikaci a vytvořte prvního administrátora
(průvodce `setup`).

---

## Nasazení na Coolify

Soubor `docker-compose.yml` v kořeni repozitáře je připraven pro Coolify.

1. **Vytvořte resource** → *Docker Compose* → nasměrujte na tento repozitář.
2. **Proměnné prostředí** — nastavte vše z `.env.example` v UI Coolify. Použijte
   silné hodnoty pro `POSTGRES_PASSWORD`, `SESSION_SECRET` a
   `MINIO_ROOT_PASSWORD` (`openssl rand -hex 32`).
3. **Domény / TLS** — reverzní proxy Coolify (Traefik) ukončuje TLS. Namapujte
   svou doménu na službu **`web`** (port kontejneru `80`). Certifikáty řeší
   Coolify, v aplikaci není co nastavovat.
4. **Objektové úložiště** — API přistupuje k MinIO přes interní
   `http://minio:9000`; veřejná subdoména úložiště ani CORS nejsou potřeba,
   protože nahrávání souborů probíhá přes API. Alternativně nasměrujte všechny
   `S3_*` na externí/spravovaný S3 bucket a služby `minio` + `createbuckets`
   můžete vypustit.
5. **Nasaďte.** Migrace se aplikují automaticky při každém startu API kontejneru.

Podrobný průvodce nasazením, zálohami a obnovou DB je v
[`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## Databáze a migrace

Produkce používá **neinteraktivní, souborové migrace** (ne `drizzle-kit push`).

```bash
# Po změně schématu (lib/db/src/schema) vygenerujte SQL migraci a commitněte ji:
pnpm --filter @workspace/db run generate

# Ruční aplikace migrací (běžně netřeba – API to dělá samo při startu):
DATABASE_URL=postgres://… pnpm --filter @workspace/db run migrate
```

`pnpm --filter @workspace/db run push` je pouze pro **lokální vývoj** – nikdy
proti produkci.

---

## Zálohy a obnova

API provádí automatické zálohy (`pg_dump -Fc`) do objektového úložiště pod
prefix `backups/`. Administrátoři je mohou spouštět a stahovat v
**Nastavení → Zálohy**. Postup obnovy přes `pg_restore` je v
[`DEPLOYMENT.md`](DEPLOYMENT.md#5-database-backups--restore).

---

## Další dokumentace

- [`DEPLOYMENT.md`](DEPLOYMENT.md) — kompletní průvodce nasazením + obnova DB
- [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) — audit připravenosti pro produkci
- [`.env.example`](.env.example) — komentovaná šablona proměnných prostředí
