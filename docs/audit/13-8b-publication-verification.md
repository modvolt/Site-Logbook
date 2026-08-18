# FÁZE 13.8B – exact-SHA publication verification

- **Datum dokončení:** 2026-08-03.
- **Repozitář:** `modvolt/Site-Logbook`.
- **Draft PR:** [#1 – Security hardening, recovery readiness, and staging release gate](https://github.com/modvolt/Site-Logbook/pull/1).
- **Publikovaná větev:** `agent/phase13-staging-gate`.
- **Výchozí remote SHA:** `88cbc461a0838c9c90de818a4c9ac2a1ed90b80f`.
- **Publikované exact SHA:** `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Quality gate:** [run 30768500267](https://github.com/modvolt/Site-Logbook/actions/runs/30768500267), `completed/success`.
- **Verdikt:** **PUBLICATION PASS / QUALITY GATE PASS / STAGING PROVISIONING BLOCKED**.
- **Produkce/main:** `main` zůstal na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Deploymenty pro publikované SHA:** `0`.
- **Migrace 0100:** nepřítomná a nedotčená.

## Publikační scope

Remote PR head byl před publikací přímým předkem lokálního checkpointu. Divergence
byla `0 behind / 2 ahead`. Publikační preflight našel jedinou čistě formátovací chybu:
nový `deploy/staging/mailpit/Dockerfile` měl nadbytečný prázdný řádek na EOF. Byla
odstraněna samostatným jednosouborovým commitem, takže konečný push obsahoval přesně
tři fast-forward commity:

1. `ac643c0` – checkpoint FÁZE 13.7;
2. `75272e9` – hardened isolated staging runtime FÁZE 13.8A;
3. `7f4bd71` – normalizace EOF Mailpit Dockerfile.

Push byl proveden bez force přímo z `HEAD` na existující PR větev
`agent/phase13-staging-gate`. SSH remote odmítl lokální klíč, proto byl pro konkrétní
fetch/push příkaz použit HTTPS a credential helper již přihlášeného `gh`. Remote URL,
globální Git konfigurace ani GitHub autentizace nebyly měněny. Následný `ls-remote`
potvrdil přesnou shodu remote headu s `7f4bd719c951dffd58f7697253156c3cb7146b23`.

Publikovaný diff proti předchozímu PR headu obsahoval pouze očekávaných 15 cest:

- staging runtime, env template a deployment dokumentaci;
- exact-SHA build argumenty v API/frontend Dockerfile;
- F13.7 governance checkpoint;
- F13.8A evidence a checkpoint.

Nebyla publikována naplněná `.env.staging`, private key, token ani migrace 0100.
`git diff --check` a cílený credential-pattern scan prošly před push.

## Remote Quality gate

Run `30768500267` vznikl událostí `pull_request` pro exact SHA
`7f4bd719c951dffd58f7697253156c3cb7146b23`. Jediný job
`hermetic-release-gate` (`91551386424`) skončil `success`. Úspěšné kroky zahrnuly:

- frozen pnpm install;
- `pnpm gate:quality`;
- `pnpm gate:release`;
- izolované API databázové testy;
- encrypted streaming object-recovery drill.

CI recovery drill krátce spustil izolovaný MinIO test target a následně jej zastavil.
Jde výhradně o hermetickou testovací službu workflow, nikoli o součást staging
architektury nebo deployment. Publikovaný `docker-compose.staging.yml` nadále používá
jen samostatný externí S3 endpoint a neobsahuje MinIO ani bucket-init službu.

Po dokončení je PR stále `OPEN`, `draft=true`, `mergeable=MERGEABLE` a
`mergeStateStatus=CLEAN`. Required status check na chráněném `main` zůstává přesně
`hermetic-release-gate`, strict/up-to-date, GitHub Actions app ID `15368`.

## Negativní důkazy

- GitHub deployments pro exact SHA: `0`;
- workflow runs pro exact SHA: pouze jeden `Quality gate`, žádný staging smoke/deploy;
- `main`: beze změny na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- žádný Coolify resource, domain, env nebo deploy;
- žádný přístup ke skutečnému S3, staging/produkční DB nebo produkci;
- žádná aplikace migrací `0096–0099`, `0101–0102` ani 0100;
- PR zůstal draft; nebyl mergeován ani označen ready for review.

## Nevyřešené otázky

1. Jaký skutečný externí S3 provider/endpoint, region a nový staging bucket budou
   použity a kdo vlastní least-privilege credential?
2. Jak se doloží oddělení od produkčního bucketu, versioning, Object Lock/retention,
   encryption, public-access block a storage fingerprint?
3. Jaký samostatný HTTPS origin mimo `modvoltapp.cz` a jaký Coolify resource/server
   budou použity?
4. Jaké typované PPE limity schválí service owner pro `ppe_signature` a
   `ppe_confirmation`?
5. Vyžaduje release policy digest pinning `node`, `nginx` a `postgres` obrazů ještě
   před prvním staging provisioningem?

F13.8B neautorizuje vytvoření S3/Coolify resource, vložení secrets, start API,
staging workflow, migrace, merge ani produkci.
