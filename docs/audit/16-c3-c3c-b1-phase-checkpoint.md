# Checkpoint R16-C3C3C-B1 – oddělené publication concurrency leases

Datum: 2026-08-09

## Výsledek

**Veřejná část úzké opravy concurrency self-collision je implementována a
lokálně ověřena.** Implementační commit je
`9883af66d959e85745a5a6f6a6e7d6a9078d908b`.

Private caller template nyní používá:

```yaml
concurrency:
  group: site-logbook-registry-publication
  cancel-in-progress: false
```

Called reusable workflow zůstává beze změny na
`site-logbook-images-publication`. Oba private publishery se proto mohou
serializovat na registry caller group, ale caller už nepožaduje stejnou lease
jako vlastní reusable workflow.

Runtime kontrakt nově fail-closed odmítá:

- jiný než právě jeden `site-logbook-registry-publication` ve wrapperu;
- jiný než právě jeden `cancel-in-progress: false`;
- přítomnost reusable group `site-logbook-images-publication` ve wrapperu.

Mutation testy pokrývají původní kolizi i změnu `cancel-in-progress` na `true`.
Ostatní publisher guardy, permissions, fixed source/tree, `linux/amd64`,
provenance, SBOM a immutable tag state machine se nezměnily.

## Provedené kontroly

- cílený runtime kontrakt: 22/22 PASS;
- predecessor evidence + runtime kontrakty: 28/28 PASS;
- `pnpm.cmd gate:staging-runtime`: PASS;
- `pnpm.cmd gate:quality`: PASS;
- strict YAML unique-key parse wrapper template a called reusable: 2/2 PASS;
- Prettier pro všechny změněné podporované soubory: PASS;
- `git diff --check` a staged diff check: PASS.

Plná Docker-backed staging-contract sada nebyla lokálně opakována, aby se
nezatížil nestabilní pracovní počítač. Po pushi musí přesný finální public PR
head projít vzdáleným Quality gate, který pinned harness připravuje.

## Bezpečnostní hranice

- jediný předchozí dispatch zůstává selhaný run `31335035618`;
- nebyl proveden rerun ani nový dispatch;
- GHCR target zůstává nepřítomný;
- private `main` ani private wrapper nebyly změněny;
- nebyl vytvořen ani mergován private PR;
- nebyl proveden deploy, Coolify změna, DB/S3/DNS zásah ani migrace;
- `0100` zůstává nezařazena a `0105` nebyla spuštěna.

Public non-force push a exact-head CI jsou poslední povolené kroky této
podfáze. Tento checkpoint je musí po publikaci doplnit externím GitHub run
důkazem; žádný publisher workflow se přitom nespouští.

## Nejasnosti a zbývající kroky

1. Root cause zůstává high-confidence inference, protože GitHub k runu
   `31335035618` nevydal run-level anotaci. Definitivní runtime potvrzení přinese
   až budoucí samostatně schválený dispatch po nasazení private wrapper opravy.
2. Opravená veřejná template zatím není v private `main`. Private změna musí
   projít samostatným one-file PR a nesmí být mergována bez výslovného souhlasu.
3. Tato fáze neautorizuje nový dispatch ani GHCR zápis.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-B2 – připravit one-file private PR s přesnou opravenou
  wrapper template, ověřit byte/hash shodu a zastavit bez merge;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: high;
- důvod použití této úrovně: jde o úzkou workflow změnu v privátním repozitáři,
  která musí zachovat manual-owner, permission, pin a no-deploy hranice;
- očekávané činnosti: po zeleném public exact-head CI vytvořit private větev,
  změnit jediný concurrency group řádek, spustit statickou kontrolu, otevřít
  draft PR a ověřit nulový počet nových workflow běhů;
- soubory, které budou pravděpodobně změněny: v private repo pouze
  `.github/workflows/publish-staging-predecessor.yml`; ve veřejném repo případně
  další auditní checkpoint;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: žádné migrace,
  deploy, dispatch ani GHCR write. Private branch/push/PR je externí změna;
  private merge zůstává za samostatným schválením.

## Stop

Checkpoint R16-C3C3C-B1 je vytvořen. Nový dispatch, GHCR, private merge, deploy a
migrace zůstávají zastavené.
