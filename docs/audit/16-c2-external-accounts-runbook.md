# R16-C2 – dark rollout runbook externích účtů

Datum: 2026-08-05

Tento runbook je příprava pro samostatně schválený staging rollout. Sám o sobě
neautorizuje merge, deploy, změnu secrets ani aplikaci migrace.

## Povinné vstupy

1. úspěšné exact-SHA CI včetně izolovaných DB testů a backup/restore;
2. aktuální úplná záloha cílové databáze a ověřený restore postup;
3. potvrzení, že journal neobsahuje nečekanou `0100` a že předchůdce `0105` je
   přesně očekávaný `0104`;
4. jméno interního custodiana s `users.manage`, pilotní externí identita, přesný
   resource typ/ID a konečná expirace;
5. dostupný admin revoke postup a pozorování auth/authorization událostí.

## Bezpečné pořadí staging rollout

1. ponechat `EXTERNAL_ACCOUNTS_ENABLED=false`;
2. aplikovat expand-only `0105_smooth_nitro.sql` pouze na schválený staging;
3. ověřit journal, interní login, `/auth/me`, sessions, offboarding inventory a
   nulový počet externích účtů;
4. nasadit API a frontend stále s flagem `false`;
5. ověřit, že admin obrazovka ukazuje dark rollout a aktivace je blokovaná;
6. vytvořit draft externího účtu, custodiana, jeden přesný scope a krátkou
   expiraci; draft se nesmí přihlásit;
7. samostatným schváleným env zásahem zapnout flag a restartovat pouze dotčenou
   službu;
8. aktivovat pilot a ověřit, že vidí pouze scoped resource, cizí resource vrací
   `404` a interní API vrací deny;
9. ověřit network-only chování, absenci SSE/offline queue a okamžité odhlášení po
   změně scope/expiry/custodiana;
10. provést revoke, ověřit neplatnost sessions a uchování event ledgeru;
11. flag znovu vypnout, dokud nejsou důkazy přijaty.

## Rollback a stop podmínky

- před prvním externím datovým záznamem lze při problému vrátit aplikaci a použít
  guarded rollback `0105_smooth_nitro.down.sql`;
- po vytvoření profilu, scope, eventu nebo externí identity rollback záměrně
  selže. Pak se vrací aplikace/flag, nikoli schema; data se revokují append-only;
- okamžitě zastavit pilot při možnosti číst cizí resource, při přístupu k jiné
  interní routě, chybějící session invalidaci, cache/offline dostupnosti po
  odhlášení nebo neúplném auditním eventu;
- nevytvářet široký scope, trvalou expiraci, permission override ani externího
  uživatele přes generický `/users` editor;
- rollback nikdy neřešit zařazením nebo aplikací migrace `0100`.

## Důkazní balíček

Uložit přesný image digest a commit SHA, migrace před/po, redigované HTTP výsledky
pro allow/deny/404, session generation před/po změnách, event IDs, čas zapnutí a
vypnutí flagu, identitu custodiana a výsledek revoke. Nezapisovat heslo, session
cookie, WebAuthn credential ani recovery secret.
