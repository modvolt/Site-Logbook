# Etapa 12: Browser smoke test opravneni zakazky

## Ucel

Etapa prevadi staticke permission kontrakty do skutecneho testu sestaveneho
frontendu v prohlizeci. Test nepouziva produkcni ani lokalni databazi. Vsechny
pozadavky `/api/**` zachyti Playwright jeste v prohlizeci a vrati deterministicka
testovaci data pro zakazku 40.

## Pokryte profily

- `read-only`: `jobs.view`, bez pracovnich a spravcovskych ovladacich prvku,
- `field`: `jobs.view + jobs.work`, aktivni ukoly bez spravy zakazky,
- `manager`: `jobs.view + jobs.work + jobs.manage`, plne spravcovske ovladani,
- bez `jobs.view`: prime URL nesmi nacist data zakazky.

## Akceptacni scenare

1. Read-only vidi nazev a stav, ale ne archivaci, casovac, zakazkovy list ani
   odeslani k podpisu. Checkbox ukolu je zakazany.
2. Terenni pracovnik vidi a muze ovladat ukol, ale nema spravcovske akce.
3. Spravce vidi spravcovske akce. Completion-readiness se nenacita pri otevreni
   detailu, ale az pri volbe stavu `Dokonceno`.
4. Prime `/jobs/new` bez `jobs.manage` zobrazi `Pristup odepren` a nenamontuje
   formulare ani dotazy na lidi a zakazniky.
5. Prime `/jobs/40` bez `jobs.view` nenacte `/api/jobs/40`.
6. Zadny scenar nesmi vyvolat frontendovou `pageerror` ani nechtenou mutaci.
7. Vsechny scenare bezi v desktopnim a mobilnim viewportu. Mobilni projekt
   pouziva stejny Chromium profil s viewportem 390 x 844; nepouziva nestabilni
   plnou iPhone emulaci lokalniho Edge.

## Spusteni

Nejprve musi existovat aktualni produkcni frontend build v
`artifacts/stavba/dist/public`.

```powershell
$env:BASE_PATH = "/"
pnpm --filter @workspace/stavba run build
pnpm --filter @workspace/e2e run test:permissions-mock
```

Konfigurace pouziva lokalni Microsoft Edge. Jinou Chromium binarku lze dodat
pres `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## Datova bezpecnost

- Staticky server neposkytuje zadne skutecne API.
- Playwright zachytava `/api/**` a odpovedi vytvari v pameti testu.
- Testovaci e-mail pouziva neexistujici domenu `.invalid`.
- Nejsou pouzity produkcni cookies ani prihlasovaci udaje.
- Service worker je vypnuty, aby nemohl vratit data z predchoziho prostredi.

## Rollback etapy 12

Etapa nema migraci ani runtime zmenu aplikace. Rollback znamena odstranit
`mock-static-server.mjs`, `playwright.permissions.config.ts`, adresar
`mock-tests`, package script a tento dokument. Produkcni data a aplikacni
workflow se tim nemeni.

## Stav overeni

- Produkcni frontend build s `BASE_PATH=/` prosel.
- E2E TypeScript kontrola vcetne mock testu prosla.
- Desktop Edge: 5/5 scenaru proslo.
- Mobilni viewport 390 x 844 v Edge: 5/5 scenaru proslo.
- Celkem: 10/10 browser testu proslo za 13,2 s.
- Test nezachytil zadnou `pageerror` ani nechtenou HTTP mutaci.
- Zprisneny mock nezachytil zadny neznamy API pozadavek; kazdy takovy pozadavek
  by vratil 501 a test by selhal.
- Read-only a field profil nevolaly completion-readiness.
- Prime zakazane URL nenamontovaly chranene komponenty ani jejich datove dotazy.

Build zachoval existujici upozorneni na nektere sourcemapy a velikost hlavnich
chunku; skoncil vsak kodem 0. Test nebyl pripojen k produkcnimu API ani DB.
