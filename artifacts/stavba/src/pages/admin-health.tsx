import { useEffect, useRef, useState } from "react";
import {
  useGetAdminHealth,
  getGetAdminHealthQueryKey,
} from "@workspace/api-client-react";
import type { AdminHealthStatus } from "@workspace/api-client-react";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, Minus, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { cs } from "date-fns/locale";

const FRONTEND_BUILD_SHA: string =
  (import.meta.env as Record<string, string>)["VITE_BUILD_SHA"] ?? "dev";

const AUTO_REFRESH_INTERVAL = 30_000;

type CardStatus = "ok" | "warning" | "error" | "info";

function StatusIcon({ status }: { status: CardStatus }) {
  if (status === "ok") return <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />;
  if (status === "warning") return <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />;
  if (status === "error") return <XCircle className="w-5 h-5 text-rose-500 shrink-0" />;
  return <Info className="w-5 h-5 text-muted-foreground shrink-0" />;
}

function statusBg(status: CardStatus) {
  if (status === "ok") return "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20";
  if (status === "warning") return "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20";
  if (status === "error") return "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20";
  return "border-border bg-card";
}

function Card({
  title,
  status,
  children,
}: {
  title: string;
  status: CardStatus;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border p-4 flex flex-col gap-2", statusBg(status))}>
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <span className="font-semibold text-sm">{title}</span>
      </div>
      <div className="text-sm text-muted-foreground space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted-foreground/70 min-w-[130px] shrink-0">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}

type SwInfo = {
  /** Stable version token derived from the SW script URL query string. */
  version: string;
  /** Human-readable lifecycle state of the active/installing/waiting SW. */
  stateLabel: string;
  /** True when a new SW version is waiting to take over. */
  updatePending: boolean;
};

function useSwInfo() {
  const [info, setInfo] = useState<SwInfo | null>(null);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) { setInfo(null); return; }
      const sw = reg.active ?? reg.installing ?? reg.waiting;
      if (!sw) { setInfo(null); return; }
      const updatePending = !!reg.waiting;
      const stateLabel =
        sw === reg.active ? "aktivní" :
        sw === reg.waiting ? "čeká na aktivaci" :
        "instaluje se";
      // Pull a build token from the SW script URL query (?v=<hash> or ?t=<ts>).
      // Falls back to the script URL basename so there's always something to display.
      const qs = sw.scriptURL.split("?")[1] ?? "";
      const version = qs.replace(/^[vt]=/, "") || sw.scriptURL.split("/").pop() || "neznáma";
      setInfo({ version, stateLabel, updatePending });
    }).catch(() => setInfo(null));
  }, []);
  return info;
}

function formatDate(iso: string) {
  return format(parseISO(iso), "d. M. yyyy HH:mm", { locale: cs });
}

function BackupRow({ label, b }: {
  label: string;
  b: { createdAt: string; status: string; sizeBytes?: number | null; trigger: string; error?: string | null; sha256?: string | null; restoredAt?: string | null } | null;
}) {
  if (!b) {
    return <Row label={label} value="—" />;
  }
  return (
    <>
      <Row label={label} value={formatDate(b.createdAt)} />
      {b.sizeBytes != null && (
        <Row label="  Velikost" value={`${(b.sizeBytes / 1024 / 1024).toFixed(2)} MB`} />
      )}
      <Row label="  Typ" value={b.trigger} />
      {b.sha256 && (
        <Row label="  SHA-256" value={`${b.sha256.slice(0, 16)}…`} />
      )}
      {b.restoredAt && (
        <Row label="  Restore test" value={formatDate(b.restoredAt)} />
      )}
      {b.error && (
        <p className="text-xs text-rose-700 dark:text-rose-400 break-all ml-[130px]">{b.error}</p>
      )}
    </>
  );
}

function HealthContent({ data }: { data: AdminHealthStatus }) {
  const swInfo = useSwInfo();

  const shaMatch =
    FRONTEND_BUILD_SHA === "dev" || data.apiVersion === "dev"
      ? null
      : FRONTEND_BUILD_SHA === data.apiVersion;

  const hasErrors = data.frontendErrorCount24h > 0 || data.backendErrorCount24h > 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

      {/* Version & SHA */}
      <Card
        title="Verze buildu"
        status={shaMatch === false ? "warning" : shaMatch === true ? "ok" : "info"}
      >
        <Row label="API verze" value={data.apiVersion} />
        <Row label="Frontend verze" value={FRONTEND_BUILD_SHA} />
        {swInfo ? (
          <>
            <Row label="SW verze" value={swInfo.version} />
            <Row label="SW stav" value={swInfo.stateLabel} />
            {swInfo.updatePending && (
              <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                ⚠ Nová verze SW čeká – zavřete a znovu otevřete aplikaci.
              </p>
            )}
          </>
        ) : (
          <Row label="Service worker" value="nenalezen / nepodporován" />
        )}
        {shaMatch === false && (
          <p className="text-xs text-amber-700 dark:text-amber-400 font-medium mt-1">
            ⚠ Frontend a API nejsou ze stejného buildu. Požádejte uživatele o obnovení stránky.
          </p>
        )}
        {shaMatch === null && (
          <p className="text-xs text-muted-foreground/60 mt-1 text-[10px]">
            SHA není k dispozici v dev prostředí.
          </p>
        )}
      </Card>

      {/* Database */}
      <Card
        title="Databáze"
        status={data.dbStatus === "ok" ? "ok" : "error"}
      >
        <Row label="Stav" value={data.dbStatus === "ok" ? "Dostupná" : "Chyba"} />
        {data.dbLatencyMs != null && (
          <Row label="Latence" value={`${data.dbLatencyMs} ms`} />
        )}
      </Card>

      {/* DB Migrations */}
      <Card
        title="DB migrace"
        status={data.migrationParity ? "ok" : "error"}
      >
        <Row label="Parity" value={data.migrationParity ? "PASS ✓" : "FAIL ✗"} />
        <Row label="Očekáváno" value={String(data.expectedMigrations)} />
        <Row label="Aplikováno" value={String(data.appliedMigrations)} />
        {data.latestExpectedTag && (
          <Row label="Poslední tag" value={data.latestExpectedTag} />
        )}
        {data.missingMigrationTags.length > 0 && (
          <div className="mt-1">
            <p className="text-xs text-rose-700 dark:text-rose-400 font-medium">Chybí:</p>
            <ul className="list-disc list-inside text-xs font-mono">
              {data.missingMigrationTags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Object Storage */}
      <Card
        title="Objektové úložiště"
        status={data.storageStatus === "ok" ? "ok" : data.storageStatus === "not_configured" ? "info" : "error"}
      >
        <Row
          label="Stav"
          value={data.storageStatus === "ok" ? "OK" : data.storageStatus === "not_configured" ? "Nenakonfigurováno" : "Chyba"}
        />
        {data.storageIsDevFallback && (
          <Row label="Backend" value="GCS/Replit (dev fallback)" />
        )}
        {data.storageDetails && <Row label="Detail" value={data.storageDetails} />}
      </Card>

      {/* SMTP */}
      <Card
        title="E-mail (SMTP)"
        status={data.smtpStatus === "configured" ? "ok" : "info"}
      >
        <Row
          label="Stav"
          value={data.smtpStatus === "configured" ? "Nakonfigurován" : "Nenakonfigurován"}
        />
        {data.smtpHost && <Row label="Host" value={data.smtpHost} />}
      </Card>

      {/* AI */}
      <Card
        title="AI extrakce (OpenAI)"
        status={data.aiStatus === "ready" ? "ok" : data.aiStatus === "configured_disabled" ? "warning" : "info"}
      >
        <Row
          label="Stav"
          value={
            data.aiStatus === "ready" ? "Aktivní" :
            data.aiStatus === "configured_disabled" ? "Nakonfigurováno (vypnuto)" :
            "Nenakonfigurováno"
          }
        />
        {data.aiModel && <Row label="Model" value={data.aiModel} />}
      </Card>

      {/* Gmail */}
      <Card
        title="Gmail import"
        status={
          data.gmailStatus === "connected" ? "ok" :
          data.gmailStatus === "disconnected" ? "warning" : "info"
        }
      >
        <Row
          label="Stav"
          value={
            data.gmailStatus === "connected" ? "Připojeno" :
            data.gmailStatus === "disconnected" ? "Odpojeno" :
            "Nenakonfigurováno"
          }
        />
        {data.gmailEmail && <Row label="Účet" value={data.gmailEmail} />}
      </Card>

      {/* IMAP */}
      <Card
        title="IMAP import"
        status={data.imapStatus === "configured" ? "ok" : "info"}
      >
        <Row
          label="Stav"
          value={data.imapStatus === "configured" ? "Nakonfigurován" : "Nenakonfigurován"}
        />
      </Card>

      {/* Error counts */}
      <Card
        title="Chyby za posledních 24 h"
        status={hasErrors ? (data.frontendErrorCount24h > 10 || data.backendErrorCount24h > 5 ? "error" : "warning") : "ok"}
      >
        <Row label="Frontend chyby" value={String(data.frontendErrorCount24h)} />
        <Row label="Backend chyby" value={String(data.backendErrorCount24h)} />
        {!hasErrors && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">Žádné chyby.</p>
        )}
        {hasErrors && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Frontend chyby: detaily v sekci Diagnostika → Frontend chyby.
          </p>
        )}
      </Card>

      {/* Backup */}
      <Card
        title="Záloha databáze"
        status={
          !data.lastSuccessfulBackup && !data.lastBackupError ? "info" :
          data.lastBackupError &&
          (!data.lastSuccessfulBackup ||
            new Date(data.lastBackupError.createdAt) > new Date(data.lastSuccessfulBackup.createdAt))
            ? "warning"
            : "ok"
        }
      >
        <BackupRow label="Poslední úspěšná" b={data.lastSuccessfulBackup ?? null} />
        {data.lastBackupError && (
          <>
            <div className="border-t border-border/40 my-1" />
            <BackupRow label="Poslední chyba" b={data.lastBackupError} />
          </>
        )}
        {!data.lastSuccessfulBackup && !data.lastBackupError && (
          <p className="text-xs text-muted-foreground">Žádná záloha zatím neproběhla.</p>
        )}
      </Card>
    </div>
  );
}

export default function AdminHealth() {
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useGetAdminHealth({
    query: {
      queryKey: getGetAdminHealthQueryKey(),
      refetchInterval: false,
      staleTime: 25_000,
    },
  });

  const doRefresh = () => {
    void refetch();
    setLastRefreshed(new Date());
  };

  useEffect(() => {
    intervalRef.current = setInterval(doRefresh, AUTO_REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between mb-2 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Activity className="w-7 h-7 text-rose-600" />
            <h1 className="text-2xl font-bold">Diagnostika systému</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Obnoveno: {format(lastRefreshed, "HH:mm:ss")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={doRefresh}
              disabled={isFetching}
              className="h-8"
            >
              <RefreshCw className={cn("w-4 h-4 mr-1.5", isFetching && "animate-spin")} />
              Obnovit
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Přehled provozního zdraví aplikace. Automaticky se obnovuje každých 30 s. Pouze pro administrátory.
        </p>

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="rounded-xl border bg-muted/30 animate-pulse h-28" />
            ))}
          </div>
        )}

        {isError && !data && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20 p-6 text-center">
            <XCircle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
            <p className="font-semibold">Chyba při načítání diagnostiky</p>
            <p className="text-sm text-muted-foreground mt-1">
              Zkontrolujte připojení nebo zkuste obnovit stránku.
            </p>
          </div>
        )}

        {data && <HealthContent data={data} />}
      </div>
    </div>
  );
}
