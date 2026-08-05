import { useEffect, useMemo, useState } from "react";
import {
  getExternalAccount,
  getListExternalAccountsQueryKey,
  useListExternalAccounts,
  type ExternalAccountDetail,
  type ExternalAccountScopeInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BiometricVaultGate } from "@/components/biometric-vault-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCog,
} from "lucide-react";

type ResourceType = "job" | "quote" | "switchboard";

const STATE_LABELS: Record<string, string> = {
  draft: "Koncept",
  active: "Aktivní",
  suspended: "Pozastavený",
  revoked: "Odvolaný",
  expired: "Expirovaný",
};

function nextYearLocal(): string {
  const date = new Date();
  date.setDate(date.getDate() + 365);
  return date.toISOString().slice(0, 16);
}

async function lifecycleRequest<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    const error = new Error(
      data?.error ?? "Operace externího účtu selhala",
    ) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data as T;
}

export default function ExternalAccountsAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [verified, setVerified] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ExternalAccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newAccount, setNewAccount] = useState({
    username: "",
    password: "",
    name: "",
    email: "",
    custodianUserId: "",
    accessExpiresAt: nextYearLocal(),
  });
  const [scopeType, setScopeType] = useState<ResourceType>("job");
  const [scopeId, setScopeId] = useState("");
  const [draftScopes, setDraftScopes] = useState<ExternalAccountScopeInput[]>(
    [],
  );
  const [expiry, setExpiry] = useState("");
  const [custodianId, setCustodianId] = useState("");
  const [revokeReason, setRevokeReason] = useState("");

  const listKey = getListExternalAccountsQueryKey({ status: "all" });
  const accounts = useListExternalAccounts(
    { status: "all" },
    { query: { queryKey: listKey, retry: false } },
  );

  const refreshList = () =>
    queryClient.invalidateQueries({ queryKey: listKey });

  const loadDetail = async (userId: number) => {
    setSelectedId(userId);
    setDetailLoading(true);
    try {
      const loaded = await getExternalAccount(userId);
      setDetail(loaded);
      setDraftScopes(
        loaded.scopes.map(({ resourceType, resourceId, capability }) => ({
          resourceType,
          resourceId,
          capability,
        })),
      );
      setExpiry(new Date(loaded.accessExpiresAt).toISOString().slice(0, 16));
      setCustodianId(String(loaded.custodianUserId));
      setRevokeReason("");
    } catch (error: any) {
      toast({
        title: "Detail se nepodařilo načíst",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (
      selectedId &&
      accounts.data &&
      !accounts.data.items.some((item) => item.userId === selectedId)
    ) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [accounts.data, selectedId]);

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast({ title: success });
      await refreshList();
      if (selectedId) await loadDetail(selectedId);
    } catch (error: any) {
      if (error?.status === 403 && error?.code === "biometric_required")
        setVerified(false);
      toast({
        title: "Operace selhala",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    if (!verified) return;
    await mutate(async () => {
      const created = await lifecycleRequest<ExternalAccountDetail>(
        "/external-accounts",
        "POST",
        {
          username: newAccount.username,
          password: newAccount.password,
          name: newAccount.name,
          email: newAccount.email || null,
          custodianUserId: Number(newAccount.custodianUserId),
          accessExpiresAt: new Date(newAccount.accessExpiresAt).toISOString(),
        },
      );
      setShowCreate(false);
      setNewAccount({
        username: "",
        password: "",
        name: "",
        email: "",
        custodianUserId: "",
        accessExpiresAt: nextYearLocal(),
      });
      await loadDetail(created.userId);
    }, "Koncept externího účtu byl vytvořen");
  };

  const scopeKey = (scope: ExternalAccountScopeInput) =>
    `${scope.resourceType}:${scope.resourceId}`;
  const canAddScope =
    Number.isSafeInteger(Number(scopeId)) && Number(scopeId) > 0;
  const addScope = () => {
    if (!canAddScope) return;
    const scope = {
      resourceType: scopeType,
      resourceId: Number(scopeId),
      capability: "read" as const,
    };
    if (!draftScopes.some((item) => scopeKey(item) === scopeKey(scope)))
      setDraftScopes((items) => [...items, scope]);
    setScopeId("");
  };

  const sortedAccounts = useMemo(
    () =>
      [...(accounts.data?.items ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, "cs"),
      ),
    [accounts.data],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Externí účty
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Připravte časově omezený účet, přiřaďte mu přesné záznamy a teprve
            potom jej aktivujte. Externí účet nikdy nedědí interní oprávnění.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void accounts.refetch()}
          disabled={accounts.isFetching}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${accounts.isFetching ? "animate-spin" : ""}`}
          />{" "}
          Obnovit
        </Button>
      </div>

      <div
        className={`rounded-xl border p-4 ${accounts.data?.runtimeEnabled ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20"}`}
      >
        <div className="flex items-start gap-3">
          {accounts.data?.runtimeEnabled ? (
            <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
          )}
          <div>
            <p className="font-semibold">
              {accounts.data?.runtimeEnabled
                ? "Přihlašování externích účtů je povoleno"
                : "Přihlašování externích účtů je globálně vypnuto"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Koncepty a scopes lze připravit bezpečně předem. Aktivace zůstane
              zablokovaná, dokud nebude runtime flag výslovně zapnutý.
            </p>
          </div>
        </div>
      </div>

      <BiometricVaultGate onVerified={() => setVerified(true)} />

      <div className="flex justify-end">
        <Button
          onClick={() => setShowCreate((value) => !value)}
          disabled={!verified}
        >
          <Plus className="mr-2 h-4 w-4" /> Nový externí účet
        </Button>
      </div>

      {showCreate && (
        <section
          className="rounded-xl border bg-card p-5"
          aria-labelledby="external-create-title"
        >
          <h2 id="external-create-title" className="text-lg font-semibold">
            Vytvořit neaktivní koncept
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              placeholder="Uživatelské jméno"
              value={newAccount.username}
              onChange={(e) =>
                setNewAccount((v) => ({ ...v, username: e.target.value }))
              }
            />
            <Input
              placeholder="Jméno kontaktu"
              value={newAccount.name}
              onChange={(e) =>
                setNewAccount((v) => ({ ...v, name: e.target.value }))
              }
            />
            <Input
              type="email"
              placeholder="E-mail (volitelný)"
              value={newAccount.email}
              onChange={(e) =>
                setNewAccount((v) => ({ ...v, email: e.target.value }))
              }
            />
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Heslo (min. 12 znaků)"
              value={newAccount.password}
              onChange={(e) =>
                setNewAccount((v) => ({ ...v, password: e.target.value }))
              }
            />
            <Input
              inputMode="numeric"
              placeholder="ID interního správce"
              value={newAccount.custodianUserId}
              onChange={(e) =>
                setNewAccount((v) => ({
                  ...v,
                  custodianUserId: e.target.value,
                }))
              }
            />
            <Input
              type="datetime-local"
              value={newAccount.accessExpiresAt}
              onChange={(e) =>
                setNewAccount((v) => ({
                  ...v,
                  accessExpiresAt: e.target.value,
                }))
              }
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Zrušit
            </Button>
            <Button
              onClick={() => void createDraft()}
              disabled={
                busy ||
                newAccount.password.length < 12 ||
                !newAccount.username ||
                !newAccount.name ||
                !newAccount.custodianUserId
              }
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{" "}
              Vytvořit koncept
            </Button>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <section
          className="overflow-hidden rounded-xl border bg-card"
          aria-labelledby="external-list-title"
        >
          <div className="border-b px-5 py-4">
            <h2 id="external-list-title" className="font-semibold">
              Inventář účtů
            </h2>
          </div>
          {accounts.isLoading ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Načítám…
            </div>
          ) : accounts.isError ? (
            <p role="alert" className="p-5 text-sm text-destructive">
              Inventář se nepodařilo načíst.
            </p>
          ) : !sortedAccounts.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Žádný externí účet zatím neexistuje.
            </p>
          ) : (
            <ul className="divide-y">
              {sortedAccounts.map((account) => (
                <li key={account.userId}>
                  <button
                    type="button"
                    onClick={() => void loadDetail(account.userId)}
                    className={`w-full px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedId === account.userId ? "bg-muted" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      <UserRoundCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{account.name}</span>
                          <span className="rounded-full bg-muted-foreground/10 px-2 py-0.5 text-xs">
                            {STATE_LABELS[account.state]}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {account.username} · {account.activeScopeCount} scope
                          · do{" "}
                          {new Date(account.accessExpiresAt).toLocaleDateString(
                            "cs-CZ",
                          )}
                        </p>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="rounded-xl border bg-card p-5"
          aria-labelledby="external-detail-title"
        >
          <h2 id="external-detail-title" className="font-semibold">
            Nastavení vybraného účtu
          </h2>
          {detailLoading ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Načítám…
            </div>
          ) : !detail ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Vyberte účet z inventáře.
            </p>
          ) : (
            <div className="mt-5 space-y-6">
              <div>
                <p className="font-medium">{detail.name}</p>
                <p className="text-sm text-muted-foreground">
                  {detail.username} · verze {detail.version}
                </p>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold">
                  Přímé read-only scopes
                </h3>
                <ul className="space-y-2">
                  {draftScopes.map((scope) => (
                    <li
                      key={scopeKey(scope)}
                      className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
                    >
                      <KeyRound className="h-4 w-4" /> {scope.resourceType} #
                      {scope.resourceId}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7 px-2"
                        onClick={() =>
                          setDraftScopes((items) =>
                            items.filter(
                              (item) => scopeKey(item) !== scopeKey(scope),
                            ),
                          )
                        }
                        aria-label={`Odebrat ${scopeKey(scope)}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <Select
                    value={scopeType}
                    onValueChange={(value) =>
                      setScopeType(value as ResourceType)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="job">Zakázka</SelectItem>
                      <SelectItem value="quote">Nabídka</SelectItem>
                      <SelectItem value="switchboard">Rozvaděč</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="numeric"
                    placeholder="ID záznamu"
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={addScope}
                    disabled={!canAddScope}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={!verified || busy || detail.status === "revoked"}
                  onClick={() =>
                    void mutate(
                      () =>
                        lifecycleRequest(
                          `/external-accounts/${detail.userId}/scopes`,
                          "PUT",
                          {
                            expectedVersion: detail.version,
                            scopes: draftScopes,
                          },
                        ),
                      "Scopes byly uloženy a staré sessions odvolány",
                    )
                  }
                >
                  Uložit přesný seznam scopes
                </Button>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Platnost a custody</h3>
                <Input
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={!verified || busy || detail.status === "revoked"}
                  onClick={() =>
                    void mutate(
                      () =>
                        lifecycleRequest(
                          `/external-accounts/${detail.userId}/expiry`,
                          "PATCH",
                          {
                            expectedVersion: detail.version,
                            accessExpiresAt: new Date(expiry).toISOString(),
                          },
                        ),
                      "Platnost byla změněna a sessions odvolány",
                    )
                  }
                >
                  Uložit novou platnost
                </Button>
                <Input
                  inputMode="numeric"
                  placeholder="ID nového interního správce"
                  value={custodianId}
                  onChange={(e) => setCustodianId(e.target.value)}
                />
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={
                    !verified ||
                    busy ||
                    detail.status === "revoked" ||
                    !custodianId
                  }
                  onClick={() =>
                    void mutate(
                      () =>
                        lifecycleRequest(
                          `/external-accounts/${detail.userId}/transfer`,
                          "POST",
                          {
                            expectedVersion: detail.version,
                            custodianUserId: Number(custodianId),
                          },
                        ),
                      "Custody byla převedena a sessions odvolány",
                    )
                  }
                >
                  Převést správce
                </Button>
              </div>

              {detail.status === "draft" && (
                <Button
                  className="w-full"
                  disabled={
                    !verified ||
                    busy ||
                    !accounts.data?.runtimeEnabled ||
                    draftScopes.length === 0
                  }
                  onClick={() =>
                    void mutate(
                      () =>
                        lifecycleRequest(
                          `/external-accounts/${detail.userId}/activate`,
                          "POST",
                          { expectedVersion: detail.version },
                        ),
                      "Externí účet byl aktivován",
                    )
                  }
                >
                  Aktivovat účet
                </Button>
              )}

              {detail.status !== "revoked" && (
                <div className="space-y-2 border-t pt-5">
                  <Input
                    placeholder="Důvod trvalého odvolání"
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                  />
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={
                      !verified || busy || revokeReason.trim().length < 3
                    }
                    onClick={() =>
                      void mutate(
                        () =>
                          lifecycleRequest(
                            `/external-accounts/${detail.userId}/revoke`,
                            "POST",
                            {
                              expectedVersion: detail.version,
                              reason: revokeReason,
                            },
                          ),
                        "Externí účet byl trvale odvolán",
                      )
                    }
                  >
                    Trvale odvolat účet
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
