# Stavba — Zpráva o připravenosti pro produkci

_Modvolt s.r.o. — finální audit před prvním nasazením (GitHub → Coolify/Hetzner)._
_Datum: 31. 5. 2026_

Tento dokument shrnuje stav aplikace před prvním produkčním nasazením, opravy
provedené v rámci tohoto auditu a doporučení pro budoucí provoz.

---

## ✅ VERDIKT: PŘIPRAVENO

Aplikace je po opravách v tomto auditu **připravena k nasazení do produkce**.
Všechny kritické problémy byly vyřešeny. Níže uvedená „doporučené opravy" nejsou
blokující — jde o vylepšení, která lze doplnit po prvním nasazení.

---

## 🔴 KRITICKÉ PROBLÉMY (vyřešeno v tomto auditu)

### 1. Přihlášení bylo rozbité pro nové relace — OPRAVENO

Router pro „trezor přístupových údajů" (`device-credentials`) používal
middleware `requireRole("master","admin")` **bez cesty** (`router.use(...)`).
Protože se všechny routery připojují bez prefixu, tento middleware se spouštěl
pro **každý** požadavek procházející řetězcem routerů — a protože byl připojen
**před** auth routerem, vracel `401` u nepřihlášených požadavků (včetně
`POST /auth/login` a `GET /auth/me`) dříve, než se vůbec dostaly k auth
handleru. Aplikace „fungovala" jen proto, že již přihlášený admin prošel
kontrolou role; po vypršení relace by se **nikdo nepřihlásil**.

**Oprava:** `requireRole` se nyní aplikuje per-route pouze na endpointy trezoru,
nikoliv globálně. Přihlášení i veřejné endpointy ověřeny end-to-end.

### 2. Chyběly zálohy databáze — OPRAVENO

Aplikace neměla žádné zálohování DB. Doplněno:

- automatické `pg_dump -Fc` zálohy do objektového úložiště (`backups/`),
- plánovač (interval `BACKUP_INTERVAL_HOURS`, výchozí 24 h),
- retence (`BACKUP_RETENTION`, výchozí 14) s úklidem starých záloh,
- admin UI (Nastavení → Zálohy): vytvoření, seznam, stav, stažení,
- log záloh (tabulka `backup_log`) se stavem running/success/failed,
- `postgresql-client-16` v Docker image API,
- postup obnovy (`pg_restore`) zdokumentován v `DEPLOYMENT.md`.

Ověřeno end-to-end: vytvoření → uložení → seznam → stažení (formát PGDMP).

### 3. Bezpečnostní hardening — OPRAVENO

- `helmet` (bezpečnostní hlavičky), `trust proxy` pro správné fungování za
  reverzní proxy (Coolify/Traefik),
- `secure` cookie v produkci,
- rate-limiting na `/auth/login` a `/auth/setup` (ochrana proti brute-force),
- allowlist typů souborů + limit velikosti (50 MB) při nahrávání přes API.

---

## 🟡 DOPORUČENÉ OPRAVY (neblokující)

- **Test obnovy záloh:** pravidelně otestovat `pg_restore` do dočasné DB —
  neověřená záloha není záloha.
- **Šifrování trezoru přístupových údajů:** hesla v `device_credentials` jsou
  uložena v plaintextu (dle návrhu, přístup omezen na role master/admin).
  Zvážit šifrování v klidu pro hlubší obranu.
- **Off-site kopie záloh:** zálohy jdou do stejného úložiště jako data. Pro
  ochranu proti ztrátě celého úložiště zvážit kopii do jiného regionu/poskytovatele.
- **Monitoring / alerting:** přidat upozornění při selhání zálohy (stav
  `failed` v `backup_log`) a health-check monitoring (`/api/healthz`).
- **Rotace SESSION_SECRET:** dokumentovat postup rotace (vynutí odhlášení).

---

## Provozní kontrolní seznam před nasazením

- [ ] Nastavit silné `SESSION_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`
      (`openssl rand -hex 32`).
- [ ] Nastavit `S3_*` proměnné a vytvořit bucket.
- [ ] Ověřit, že API dosáhne na úložiště přes `S3_ENDPOINT` (nahrávání jde přes
      API — veřejná subdoména úložiště ani CORS nejsou potřeba).
- [ ] Nastavit doménu na službu `web` (Coolify/Traefik řeší TLS).
- [ ] Ponechat `BACKUP_ENABLED=true`; ověřit první zálohu po nasazení.
- [ ] Po nasazení provést první přihlášení / `/auth/setup` (vytvoření admina).
- [ ] (SMTP) Vyplnit `SMTP_*`, pokud se má posílat PDF zakázkový list e-mailem.

Detaily konfigurace a postupy viz `DEPLOYMENT.md` a `.env.example`.
