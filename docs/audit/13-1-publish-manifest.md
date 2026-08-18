# FÁZE 13.1 – manifest kandidáta k publikaci

- **Datum:** 2026-08-02.
- **Remote:** `git@github.com:modvolt/Site-Logbook.git`.
- **Remote default branch:** `main` na
  `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Lokální kandidát:** `e90d866fbe04daa1cce1363bbb243ab6430f2365`.
- **Rozsah:** `origin/main..HEAD`, 42 lineárních commitů, 0 merge commitů,
  268 souborů, 108 486 vložení a 3 503 odstranění.
- **Stav publikace:** **BLOCKED**; žádná větev, push ani pull request nebyly
  vytvořeny.

## Proč nelze publikovat jen FÁZI 13

Commit `e90d866` není samostatný patch nad aktuálním remote `main`. Odkazuje na
release gate, bezpečnostní invarianty, recovery tooling a package infrastrukturu,
které na vzdáleném `main` nejsou. Samostatný cherry-pick by proto nevytvořil
ověřený ani úplný staging gate. Publikovatelnou jednotkou je až výslovně
odsouhlasený celý rozsah níže, případně nově připravená a znovu ověřená integrační
větev.

## Logické bloky rozsahu

| Blok | Commity            | Obsah                                                                                                             | Riziko                                                     |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A    | `f1bb210..2957d32` | hermetický gate, lifecycle účtů, session epoch                                                                    | autentizace, session invalidace, migrace 0096              |
| B    | `77422e6..2c05eba` | explicitní routy, vault step-up, autorizace objektů, default deny                                                 | autorizační hranice, privátní data, route manifest         |
| C    | `71bf9d8..1ed61f4` | PWA identity partition, durable idempotence, cross-tab replay                                                     | offline souběh, lokální data, migrace 0097                 |
| D    | `63ba086..5dc93dc` | upload ledger, envelope encryption, canonical origin, one-time tokeny, immutable dokumenty, mail/export perimeter | storage, klíče, veřejné tokeny, podpisy, migrace 0098–0102 |
| E    | `2089810..e90d866` | verifikace, stabilizační gate, encrypted recovery, staging release gate                                           | CI, recovery, provider IAM/retence, externí staging        |

## Úplný seznam commitů

```text
f1bb210 test: add hermetic release gate
da5e734 security: rotate authenticated sessions
f5f6349 security: retire question based password recovery
8ddea6d security: harden account lifecycle
25566ab docs: checkpoint phase 8 account hardening
2c660c1 test: scrub auth secrets from release gate
ee605e6 docs: finalize phase 8 checkpoint
b5ef912 security: invalidate stale authenticated sessions
bf18843 test: prove auth lifecycle on isolated database
2957d32 docs: checkpoint phase 8 session lifecycle
77422e6 security: make public api routes explicit
8d3c4b9 security: enforce credential vault permissions
cce68a7 docs: checkpoint phase 8 authorization boundary
96e5e96 security: require vault step-up authentication
cf34a09 security: authorize private object downloads
a302a44 docs: checkpoint phase 8 object authorization
fbff6fa security: make ppe token routes explicit
5b7dbb0 security: default deny unregistered api routes
2c05eba docs: checkpoint phase 8 route manifest
71bf9d8 security: bind offline replay to auth epoch
7e9d819 security: partition pwa storage by identity
2c6b52b docs: checkpoint phase 8 pwa identity isolation
45937f6 security: deduplicate offline mutations durably
583eaa4 reliability: serialize offline replay across tabs
1ed61f4 docs: checkpoint phase 8 offline replay safety
63ba086 security: harden upload and object staging
c7cd420 docs: checkpoint phase 8 upload protection
5d1b041 security: encrypt stored secrets and database backups
cebfd88 docs: checkpoint phase 8 secret encryption
b620014 security: trust a canonical public application origin
4b42ef6 docs: checkpoint phase 8 public origin hardening
a749475 security: enforce one-time public access tokens
feaf249 docs: checkpoint phase 8 public token lifecycle
fefc67e security: bind signatures and quotes to immutable versions
b6adf8c docs: checkpoint phase 8 immutable document evidence
7510a9c security: harden perimeter mail and exports
5dc93dc docs: close phase 8 critical remediation
2089810 docs: complete phase 9 verification
8ebd0e5 test: complete phase 10 stabilization gate
e9b05d7 feat: add encrypted object recovery bundles
667f202 feat: complete phase 12 recovery readiness gate
e90d866 feat: add phase 13 staging release gate
```

## Databázové migrace v kandidátovi

| Migrace                              | Hlavní oblast          | Rollback soubor | Publikační dopad                                   |
| ------------------------------------ | ---------------------- | --------------- | -------------------------------------------------- |
| `0096_daffy_puppet_master`           | auth/session lifecycle | ano             | staging deploy může měnit autentizační stav        |
| `0097_api_idempotency_records`       | durable idempotence    | ano             | nová stavová tabulka pro mutation replay           |
| `0098_object-upload-ledger`          | upload ledger          | ano             | mění storage metadata a upload lifecycle           |
| `0099_secret_envelope_encryption`    | envelope encryption    | ano             | vyžaduje správnou key custody a secret konfiguraci |
| `0101_public_access_token_lifecycle` | one-time public tokeny | ano             | mění veřejný přístup a replay pravidla             |
| `0102_immutable_job_quote_versions`  | immutable evidence     | ano             | mění dokumentové verze a podpisové vazby           |

Čistý commit kandidáta záměrně obsahuje indexy 0099 a 0101 bez indexu 0100.
Současný špinavý uživatelský worktree má necommitnutou migraci
`0100_user_ui_preferences`, změnu journalu a související UI/schema práci. Tyto
soubory nejsou součástí 42commitového kandidáta, nebyly stagingovány ani měněny.
Před publikací je nutné explicitně rozhodnout, zda se kandidát publikuje s touto
číselnou mezerou, nebo se nejprve vytvoří nová integrační větev zahrnující
samostatně dokončenou migraci 0100 a zopakuje se celý gate.

## Bezpečná publikační strategie

1. Uživatel schválí přesný rozsah `f1bb210..e90d866` a rozhodnutí k migraci 0100.
2. Nainstaluje a autentizuje GitHub CLI nebo poskytne ekvivalentní autorizovaný
   publikační kanál.
3. Vznikne nová větev `agent/phase13-staging-gate`; `main` zůstane nedotčen.
4. Z přesně ověřeného SHA se vytvoří draft pull request a proběhne remote quality
   workflow.
5. Merge, staging deploy, migrace i produkce zůstávají samostatné, výslovně
   schvalované kroky.

Tento manifest není souhlas s publikací a není release evidence.
