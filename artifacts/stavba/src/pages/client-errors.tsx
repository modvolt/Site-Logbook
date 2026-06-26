import { useState } from "react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListClientErrors,
  getListClientErrorsQueryKey,
  usePurgeClientErrors,
} from "@workspace/api-client-react";
import type { ClientError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const DEFAULT_RETENTION_DAYS = 90;

function ExpandableRow({ error }: { error: ClientError }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!(error.stack || error.componentStack);

  return (
    <>
      <tr
        className={`border-t hover:bg-muted/30 align-top ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-xs">
          {format(new Date(error.createdAt), "d.M.yyyy HH:mm:ss")}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-xs">
          {error.userRole ? (
            <span className="inline-flex items-center gap-1">
              <span className="font-medium">{error.userId != null ? `#${error.userId}` : "—"}</span>
              <span className="text-muted-foreground">({error.userRole})</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Nepřihlášen</span>
          )}
        </td>
        <td className="px-3 py-3 text-xs max-w-[340px]">
          <div className="flex items-start gap-1">
            <span className="break-words min-w-0 flex-1 font-mono text-rose-700 dark:text-rose-400" title={error.message}>
              {error.message}
            </span>
            {hasDetail && (
              <span className="shrink-0 text-muted-foreground mt-0.5">
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground max-w-[200px] truncate" title={error.path ?? ""}>
          {error.path || <span className="italic">—</span>}
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground max-w-[180px] truncate" title={error.userAgent ?? ""}>
          {error.userAgent || <span className="italic">—</span>}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-t bg-muted/20">
          <td colSpan={5} className="px-4 py-3">
            {error.stack && (
              <div className="mb-2">
                <p className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">Stack trace</p>
                <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 bg-muted rounded p-2 max-h-64 overflow-auto">
                  {error.stack}
                </pre>
              </div>
            )}
            {error.componentStack && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">Component stack</p>
                <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 bg-muted rounded p-2 max-h-64 overflow-auto">
                  {error.componentStack}
                </pre>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function ClientErrors() {
  const [page, setPage] = useState(0);
  const qc = useQueryClient();

  const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isLoading } = useListClientErrors(params, {
    query: { queryKey: getListClientErrorsQueryKey(params) },
  });

  const purge = usePurgeClientErrors({
    mutation: {
      onSuccess: (result) => {
        const { deleted, olderThanDays } = result;
        if (deleted === 0) {
          toast.info(`Žádné záznamy starší než ${olderThanDays} dní.`);
        } else {
          toast.success(`Smazáno ${deleted} záznam${deleted === 1 ? "" : deleted < 5 ? "y" : "ů"} starších než ${olderThanDays} dní.`);
        }
        setPage(0);
        void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes("client-errors") });
      },
      onError: () => {
        toast.error("Nepodařilo se smazat záznamy.");
      },
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const retentionDays = DEFAULT_RETENTION_DAYS;

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <Bug className="w-7 h-7 text-rose-600" />
          <h1 className="text-2xl font-bold">Frontend chyby</h1>
        </div>
        <div className="flex items-start justify-between gap-4 mb-6">
          <p className="text-sm text-muted-foreground">
            Záznamy pádů aplikace zachycené hranicí chyb — klikněte na řádek pro zobrazení stack trace.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive">
                <Trash2 className="w-4 h-4" />
                Smazat staré záznamy
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Smazat staré záznamy chyb?</AlertDialogTitle>
                <AlertDialogDescription>
                  Tato akce trvale smaže všechny záznamy starší než{" "}
                  <strong>{retentionDays} dní</strong>. Nedá se vrátit zpět.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Zrušit</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => purge.mutate({ params: { olderThanDays: retentionDays } })}
                >
                  Smazat
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 text-left whitespace-nowrap">Čas</th>
                  <th className="px-3 py-3 text-left whitespace-nowrap">Uživatel (role)</th>
                  <th className="px-3 py-3 text-left">Chybová zpráva</th>
                  <th className="px-3 py-3 text-left">Cesta</th>
                  <th className="px-3 py-3 text-left">User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [1, 2, 3, 4, 5].map((i) => (
                    <tr key={i} className="border-t">
                      <td colSpan={5} className="px-3 py-2">
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                      Žádné záznamy
                    </td>
                  </tr>
                ) : (
                  items.map((e) => <ExpandableRow key={e.id} error={e} />)
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-muted-foreground">
            Celkem: <strong>{total}</strong>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              Strana {page + 1} z {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
