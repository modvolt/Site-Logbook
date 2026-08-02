# Checkpoint FÁZE 13.7 – solo-maintainer governance bootstrap

- **Datum:** 2026-08-02.
- **Stav fáze:** **COMPLETE**.
- **Verdikt:** **PPE POLICY PASS / GOVERNANCE PASS / STAGING DEPLOY BLOCKED**.
- **Publikovaný PR head:** `88cbc461a0838c9c90de818a4c9ac2a1ed90b80f`.
- **Quality gate:** [30764192158](https://github.com/modvolt/Site-Logbook/actions/runs/30764192158),
  `completed/success`.
- **PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1),
  stále otevřený draft.
- **Main/produkce:** `main` zůstal na `a25c312`; žádný merge nebo deploy.
- **Migrace 0100:** nepřítomná a nedotčená.

## Uložené výstupy

- [centrální governance a PPE evidence](13-7-solo-maintainer-governance.md)
- [aktivní public-token runbook](08-public-token-runbook.md)
- [aktivní staging runbook](13-staging-activation-runbook.md)
- [staging evidence template v2](13-staging-evidence.template.json)

## Shrnutí

PPE preflight nyní povinně rozlišuje `ppe_signature` a `ppe_confirmation`, oba bez
defaultu a každý s vlastním limitem 1–3650 dní. Chybné nebo neúplné zadání je
fail-closed. Staging evidence schema v2 zachovává dual-control režim a přidává
pravdivý solo-maintainer owner waiver s povinnými kompenzačními kontrolami.

`main` je nově chráněn PR, strict exact checkem `hermetic-release-gate`, lineární
historií a vyřešenými konverzacemi; ochrana platí i pro admina a zakazuje force-push
i delete. Environment `staging` existuje s 5min wait timerem a jedinou povolenou PR
větví. URL, admin secrets a mail readiness zůstávají úmyslně nedokončené, takže smoke
nemůže bezpečně proběhnout.

Úplný lokální gate i remote Quality gate jsou zelené na přesném publikovaném SHA.
Produkce ani staging nebyly spuštěny. Uživatel přijal budoucí jednorázové odhlášení
starých session; login a hesla se nemění.

## Jednoznačný checkpoint

FÁZE 13.7 zde končí. Governance bootstrap a úzká PPE změna jsou dokončené a
publikované, ale staging runtime ještě neexistuje. Tento dokumentační checkpoint
zůstane lokální, aby nevznikl nový remote SHA bez dalšího Quality gate.

Automaticky se nepokračuje do Compose změn, Coolify provisioning, workflow dispatch,
migrací, merge ani produkce.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8A – hardened Coolify staging runtime definition; připravit
  deployment-only Compose overlay a secret-free env kontrakt, ale ještě nevytvářet
  ani nenasazovat Coolify resource;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** runtime definice musí současně izolovat DB, storage,
  mail a credentials, správně propagovat exact build SHA a zabránit nechtěnému
  použití produkčních env hodnot nebo externímu MinIO/SMTP přístupu;
- **očekávané činnosti:** vytvořit staging-only Compose overlay s interním a
  připnutým mail sandboxem, odstranit veřejné MinIO porty, oddělit volumes a názvy,
  propagovat `BUILD_SHA`/`VITE_BUILD_SHA`, vytvořit secret-free staging env template,
  ověřit `docker compose config`, image build, health/readiness a fail-closed guard.
  Neprovádět Coolify deploy ani GitHub staging workflow dispatch;
- **soubory, které budou pravděpodobně změněny:** nový
  `docker-compose.staging.yml`, `artifacts/api-server/Dockerfile`,
  `artifacts/stavba/Dockerfile`, případně `.env.staging.example`, `DEPLOYMENT.md` a
  `docs/audit/13-8a-*`. Produkční aplikační funkce ani UI se nemají měnit;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** migrace ani DB
  se nemají spouštět a 0100 zůstává vyloučená. Jde ale o rizikovou deployment
  konfiguraci; chyba by mohla propojit staging s produkčními secrets/storage/mailem.
  Skutečný Coolify provisioning a automatická aplikace migrací 0096–0099 a
  0101–0102 patří až do samostatně autorizované pozdější fáze.
