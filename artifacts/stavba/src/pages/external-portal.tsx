import {
  getListExternalPortalResourcesQueryKey,
  useLogout,
  useListExternalPortalResources,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  BriefcaseBusiness,
  CircuitBoard,
  FileText,
  Loader2,
  LogOut,
  RefreshCw,
  Wifi,
} from "lucide-react";

const TYPE_META = {
  job: { label: "Zakázka", icon: BriefcaseBusiness },
  quote: { label: "Nabídka", icon: FileText },
  switchboard: { label: "Rozvaděč", icon: CircuitBoard },
} as const;

export default function ExternalPortal() {
  const { user } = useAuth();
  const resources = useListExternalPortalResources({
    query: {
      queryKey: getListExternalPortalResourcesQueryKey(),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: "always",
    },
  });
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        window.location.href = import.meta.env.BASE_URL;
      },
    });
  };

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight">MODVOLT</p>
            <p className="text-sm text-muted-foreground">
              Externí přístup k přiřazeným záznamům
            </p>
          </div>
          <div className="ml-auto hidden min-w-0 text-right sm:block">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.username}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            disabled={logout.isPending}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Odhlásit
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Sdílené záznamy
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Vidíte pouze položky, které vám správce výslovně přiřadil. Tento
              portál funguje pouze online a data neukládá pro práci bez
              připojení.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Wifi className="h-3.5 w-3.5" />
              Pouze online
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resources.refetch()}
              disabled={resources.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${resources.isFetching ? "animate-spin" : ""}`}
              />
              Obnovit
            </Button>
          </div>
        </div>

        {resources.isLoading ? (
          <div className="flex min-h-52 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Načítám přístup…
          </div>
        ) : resources.isError ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-5"
          >
            <h2 className="font-semibold">Záznamy se nepodařilo načíst</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Zkontrolujte připojení a zkuste stránku obnovit.
            </p>
          </div>
        ) : !resources.data?.items.length ? (
          <div className="rounded-xl border bg-card px-6 py-14 text-center">
            <h2 className="text-lg font-semibold">
              Zatím nemáte přiřazený žádný záznam
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
              Jakmile správce přidá oprávnění k zakázce, nabídce nebo rozvaděči,
              objeví se zde.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y" aria-label="Přiřazené záznamy">
              {resources.data.items.map((item) => {
                const meta = TYPE_META[item.resourceType];
                const Icon = meta.icon;
                const resource = item.resource;
                const title =
                  resource.title ??
                  resource.designation ??
                  `${meta.label} #${resource.id}`;
                const detail =
                  item.resourceType === "job"
                    ? [resource.date, resource.clientSite ?? resource.address]
                        .filter(Boolean)
                        .join(" · ")
                    : item.resourceType === "quote"
                      ? [
                          resource.quoteNumber,
                          resource.validUntil
                            ? `platnost ${resource.validUntil}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : [resource.manufacturer, resource.installationLocation]
                          .filter(Boolean)
                          .join(" · ");
                return (
                  <li
                    key={item.scopeId}
                    className="flex items-start gap-4 px-4 py-5 sm:px-6"
                  >
                    <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold">{title}</h2>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {meta.label}
                        </span>
                      </div>
                      {detail && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {detail}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-muted-foreground">
                        Stav: {resource.status} · Přístup do{" "}
                        {new Date(item.expiresAt).toLocaleDateString("cs-CZ")}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
