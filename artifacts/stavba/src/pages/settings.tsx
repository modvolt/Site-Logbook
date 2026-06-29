import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { formatDistanceToNow } from "date-fns";
import { cs } from "date-fns/locale";
import { Moon, Sun, Monitor, Building2, Upload, X, Palette, PenLine, Mail, Send, Save, Database, Download, RefreshCw, CheckCircle2, XCircle, Loader2, RotateCcw, AlertTriangle, KeyRound, ShieldQuestion, ZoomIn, CalendarDays, Smartphone, Laptop, LogOut, FlaskConical, Clock } from "lucide-react";
import { FileDropZone } from "@/components/file-drop-zone";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  useGetEmailSettings,
  useUpdateEmailSettings,
  useSendTestEmail,
  getGetEmailSettingsQueryKey,
  type EmailSettingsInput,
  useGetEmailImportSettings,
  useUpdateEmailImportSettings,
  useTestEmailImportConnection,
  usePollEmailImport,
  useListEmailImportLog,
  useRetryEmailImportLog,
  getGetEmailImportSettingsQueryKey,
  getListEmailImportLogQueryKey,
  type EmailImportSettingsInput,
  type EmailImportLogEntry,
  useListBackups,
  useCreateBackup,
  useRestoreBackup,
  useTestBackupRestore,
  useGetBackupSettings,
  useUpdateBackupSettings,
  useGetBackupStatus,
  getListBackupsQueryKey,
  getGetBackupSettingsQueryKey,
  getGetBackupStatusQueryKey,
  downloadBackup,
  type Backup,
  type BackupStatus,
  type BackupSettingsInput,
  useGetSecurityQuestionsStatus,
  useSetSecurityQuestions,
  getGetSecurityQuestionsStatusQueryKey,
  useGetLeaveSettings,
  useUpdateLeaveSettings,
  getGetLeaveSettingsQueryKey,
  useListMySessions,
  getListMySessionsQueryKey,
  useDeleteSession,
} from "@workspace/api-client-react";
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
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  loadCompanySettings,
  saveCompanySettings,
  applyTextColor,
  applyUiScale,
  UI_SCALE_OPTIONS,
  DEFAULT_UI_SCALE,
  type CompanySettings,
} from "@/lib/company-settings";
import { hardRefreshApp } from "@/lib/pwa";

const MAX_LOGO_BYTES = 500 * 1024;
const MAX_SIGNATURE_BYTES = 500 * 1024;

type EmailForm = {
  enabled: boolean;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
};

const EMPTY_EMAIL_FORM: EmailForm = {
  enabled: false,
  host: "",
  port: "587",
  secure: false,
  username: "",
  password: "",
  fromAddress: "",
  fromName: "",
};

type EmailImportForm = {
  enabled: boolean;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  folder: string;
  markSeen: boolean;
  pollMinutes: string;
};

const EMPTY_EMAIL_IMPORT_FORM: EmailImportForm = {
  enabled: false,
  host: "",
  port: "993",
  secure: true,
  username: "",
  password: "",
  folder: "INBOX",
  markSeen: true,
  pollMinutes: "15",
};

const IMPORT_STATUS_LABELS: Record<string, string> = {
  imported: "Naimportováno",
  no_attachments: "Bez příloh",
  skipped: "Přeskočeno (duplicita)",
  failed: "Chyba (zkusí se znovu)",
  failed_permanent: "Trvalá chyba",
};

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BackupStatusBadge({ status }: { status: Backup["status"] }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> Hotovo
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <XCircle className="h-3.5 w-3.5" /> Selhalo
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Probíhá
    </span>
  );
}

function RestoreTestBadge({ backup }: { backup: Backup }) {
  const rs = backup.restoreStatus;
  if (rs === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400" title={`Otestováno: ${backup.restoreTestedAt ? formatDateTime(backup.restoreTestedAt) : ""}`}>
        <FlaskConical className="h-3 w-3" /> OK
      </span>
    );
  }
  if (rs === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive" title={backup.restoreError ?? "Restore test selhal"}>
        <FlaskConical className="h-3 w-3" /> Selhalo
      </span>
    );
  }
  if (rs === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Testuje se…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
      <FlaskConical className="h-3 w-3" /> Neověřeno
    </span>
  );
}

const DAY_NAMES = ["Neděle", "Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota"];

function BackupCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListBackups({
    query: { queryKey: getListBackupsQueryKey() },
  });
  const createMutation = useCreateBackup();
  const restoreMutation = useRestoreBackup();
  const restoreTestMutation = useTestBackupRestore();
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const handleCreate = () => {
    createMutation.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Záloha vytvořena", description: "Databáze byla úspěšně zazálohována." });
        queryClient.invalidateQueries({ queryKey: getListBackupsQueryKey() });
      },
      onError: (err: unknown) => {
        const message =
          err && typeof err === "object" && "error" in err
            ? String((err as { error: unknown }).error)
            : "Vytvoření zálohy se nezdařilo.";
        toast({ title: "Chyba", description: message, variant: "destructive" });
      },
    });
  };

  const handleDownload = async (backup: Backup) => {
    setDownloadingId(backup.id);
    try {
      const blob = await downloadBackup(backup.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backup.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Chyba", description: "Stažení zálohy se nezdařilo.", variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleRestore = (backup: Backup) => {
    setRestoringId(backup.id);
    restoreMutation.mutate(
      { id: backup.id },
      {
        onSuccess: () => {
          toast({
            title: "Databáze obnovena",
            description:
              "Data byla obnovena ze zálohy. Pro jistotu se prosím znovu přihlaste.",
          });
          queryClient.invalidateQueries();
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : "Obnovení ze zálohy se nezdařilo.";
          toast({ title: "Chyba", description: message, variant: "destructive" });
        },
        onSettled: () => {
          setRestoringId(null);
        },
      },
    );
  };

  const handleRestoreTest = (backup: Backup) => {
    setTestingId(backup.id);
    restoreTestMutation.mutate(
      { id: backup.id },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListBackupsQueryKey() });
          if (result.restoreStatus === "ok") {
            const ms = result.restoreDurationMs;
            const dur = ms != null ? ` (${(ms / 1000).toFixed(1)} s)` : "";
            toast({
              title: "Restore test úspěšný",
              description: `Záloha je obnovitelná${dur}.`,
            });
          } else {
            toast({
              title: "Restore test selhal",
              description: result.restoreError ?? "Neznámá chyba",
              variant: "destructive",
            });
          }
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : "Restore test se nezdařil.";
          toast({ title: "Chyba", description: message, variant: "destructive" });
        },
        onSettled: () => {
          setTestingId(null);
        },
      },
    );
  };

  const items = data?.items ?? [];
  const lastSuccessAt = data?.lastSuccessAt ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Zálohy databáze
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {lastSuccessAt ? (
              <>
                Poslední úspěšná záloha:{" "}
                <span className="font-medium text-foreground">{formatDateTime(lastSuccessAt)}</span>
              </>
            ) : (
              "Zatím nebyla vytvořena žádná úspěšná záloha."
            )}
          </div>
          <Button type="button" onClick={handleCreate} disabled={createMutation.isPending} className="gap-2">
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Zálohovat nyní
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Automatická záloha probíhá denně. Zálohy se ukládají do objektového úložiště; zde je můžete
          stáhnout pro bezpečné uložení mimo server.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Načítání…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Žádné zálohy.</p>
        ) : (
          <div className="divide-y rounded-md border">
            {items.map((backup) => (
              <div key={backup.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <BackupStatusBadge status={backup.status} />
                    <span className="text-xs text-muted-foreground">
                      {backup.trigger === "auto" ? "automatická" : "ruční"}
                    </span>
                    {backup.status === "success" && (
                      <>
                        <span className="text-xs text-muted-foreground/50">·</span>
                        <RestoreTestBadge backup={backup} />
                      </>
                    )}
                  </div>
                  <div className="truncate text-sm font-medium">{formatDateTime(backup.createdAt)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(backup.sizeBytes)}
                    {backup.error ? ` · ${backup.error}` : ""}
                    {backup.restoreStatus === "ok" && backup.restoreTestedAt && (
                      <span> · test {formatDateTime(backup.restoreTestedAt)}{backup.restoreDurationMs != null ? ` (${(backup.restoreDurationMs / 1000).toFixed(1)} s)` : ""}</span>
                    )}
                    {backup.restoreStatus === "failed" && backup.restoreError && (
                      <span className="text-destructive"> · {backup.restoreError}</span>
                    )}
                  </div>
                </div>
                {backup.status === "success" && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={downloadingId === backup.id || restoringId !== null || testingId !== null}
                      onClick={() => handleDownload(backup)}
                    >
                      {downloadingId === backup.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      Stáhnout
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={testingId !== null || restoringId !== null}
                      onClick={() => handleRestoreTest(backup)}
                    >
                      {testingId === backup.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FlaskConical className="h-4 w-4" />
                      )}
                      {testingId === backup.id ? "Testuje se…" : "Test obnovy"}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          disabled={restoringId !== null || testingId !== null}
                        >
                          {restoringId === backup.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                          Obnovit
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-destructive" />
                            Obnovit databázi ze zálohy?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="space-y-2">
                            <span className="block">
                              Tímto se <strong>přepíšou všechna současná data</strong> stavem ze
                              zálohy z{" "}
                              <strong>{formatDateTime(backup.createdAt)}</strong>. Vše, co bylo
                              vytvořeno nebo změněno po této záloze, bude nenávratně ztraceno.
                            </span>
                            <span className="block">
                              Po obnově budete pravděpodobně odhlášeni — poté se prosím znovu
                              přihlaste.
                            </span>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={restoringId !== null}>
                            Zrušit
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleRestore(backup)}
                          >
                            Obnovit ze zálohy
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BackupSystemStatusPanel({ status }: { status: BackupStatus }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
      <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">Stav zálohovacího systému</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Automatické zálohy</span>
          {status.enabled ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Zapnuto
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <XCircle className="h-3.5 w-3.5" /> Vypnuto
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">pg_dump</span>
          {status.pgDumpAvailable ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400" title={status.pgDumpVersion ?? undefined}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Dostupný
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-destructive" title={status.pgDumpVersion ?? "pg_dump nebyl nalezen nebo nesplňuje verzi 16+"}>
              <AlertTriangle className="h-3.5 w-3.5" /> Nedostupný
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Interval zálohy</span>
          <span className="text-xs font-medium">{status.intervalHours}h</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Příští plánovaná záloha</span>
          <span className="text-xs font-medium">
            {status.nextScheduledAt ? formatDateTime(status.nextScheduledAt) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Poslední pokus</span>
          <span className="text-xs font-medium">
            {status.lastAttemptAt ? (
              <>
                {formatDateTime(status.lastAttemptAt)}
                {status.lastAttemptStatus && (
                  <span className={`ml-1 ${status.lastAttemptStatus === "success" ? "text-green-600 dark:text-green-400" : status.lastAttemptStatus === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    ({status.lastAttemptStatus === "success" ? "OK" : status.lastAttemptStatus === "failed" ? "chyba" : "probíhá"})
                  </span>
                )}
              </>
            ) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Poslední ověřený restore</span>
          <span className="text-xs font-medium">
            {status.lastVerifiedRestoreAt ? formatDateTime(status.lastVerifiedRestoreAt) : "—"}
          </span>
        </div>
      </div>
      {!status.pgDumpAvailable && (
        <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive mt-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Binárka <code>pg_dump</code> nebyla nalezena nebo nesplňuje požadovanou verzi PostgreSQL 16+.
            Zálohy nebudou fungovat, dokud nebude nainstalována kompatibilní verze.
            {status.pgDumpVersion && <> Detekováno: <em>{status.pgDumpVersion}</em>.</>}
          </span>
        </div>
      )}
    </div>
  );
}

function BackupScheduleCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetBackupSettings({
    query: { queryKey: getGetBackupSettingsQueryKey() },
  });
  const { data: status } = useGetBackupStatus({
    query: { queryKey: getGetBackupStatusQueryKey(), refetchInterval: 30_000 },
  });
  const updateMutation = useUpdateBackupSettings();

  const [dayOfWeek, setDayOfWeek] = useState<string>("disabled");
  const [notifyEmail, setNotifyEmail] = useState<string>("");

  useEffect(() => {
    if (!data) return;
    setDayOfWeek(data.restoreTestDayOfWeek != null ? String(data.restoreTestDayOfWeek) : "disabled");
    setNotifyEmail(data.restoreNotifyEmail ?? "");
  }, [data]);

  function handleSave() {
    const body: BackupSettingsInput = {
      restoreTestDayOfWeek: dayOfWeek === "disabled" ? null : Number(dayOfWeek),
      restoreNotifyEmail: notifyEmail.trim() || null,
    };
    updateMutation.mutate(
      { data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBackupSettingsQueryKey() });
          toast({ title: "Nastavení restore testu uloženo" });
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : "Uložení selhalo.";
          toast({ title: "Chyba", description: message, variant: "destructive" });
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-5 w-5" />
          Automatický restore test záloh
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && <BackupSystemStatusPanel status={status} />}

        <p className="text-sm text-muted-foreground">
          Každý týden server automaticky ověří, že nejnovější záloha je skutečně obnovitelná,
          a to bez dotyku produkčních dat (restore do dočasné DB). Při selhání odešle e-mail.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Načítání…</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Den v týdnu pro automatický test</label>
              <select
                className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(e.target.value)}
              >
                <option value="disabled">Vypnuto (bez automatického testu)</option>
                {DAY_NAMES.map((name, i) => (
                  <option key={i} value={String(i)}>{name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Test se spustí jednou týdně ve zvolený den. Pro plně persistentní zálohy nastavte
                v Replit Scheduled Deployment POST na{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">/api/internal/backup-trigger</code>{" "}
                s hlavičkou <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization: Bearer BACKUP_TRIGGER_SECRET</code>.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">E-mail pro notifikaci selhání</label>
              <Input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="admin@example.com (prázdné = všichni admini)"
                className="max-w-sm"
              />
              <p className="text-xs text-muted-foreground">
                Necháte-li prázdné, upozornění dostane každý aktivní admin s nastaveným e-mailem.
              </p>
            </div>

            <Button
              type="button"
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              {updateMutation.isPending ? "Ukládání…" : "Uložit nastavení"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmailSettingsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetEmailSettings({
    query: { queryKey: getGetEmailSettingsQueryKey() },
  });
  const updateMutation = useUpdateEmailSettings();
  const testMutation = useSendTestEmail();

  const [form, setForm] = useState<EmailForm>(EMPTY_EMAIL_FORM);
  const [passwordSet, setPasswordSet] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [source, setSource] = useState<"db" | "env" | "none">("none");
  const [portError, setPortError] = useState<string | null>(null);
  const [testEmailError, setTestEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setForm({
      enabled: data.enabled,
      host: data.host ?? "",
      port: String(data.port ?? 587),
      secure: data.secure,
      username: data.username ?? "",
      password: "",
      fromAddress: data.fromAddress ?? "",
      fromName: data.fromName ?? "",
    });
    setPasswordSet(data.passwordSet);
    setPasswordTouched(false);
    setSource(data.source);
  }, [data]);

  function set<K extends keyof EmailForm>(key: K, value: EmailForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function applyGmailPreset() {
    setForm((f) => ({ ...f, host: "smtp.gmail.com", port: "587", secure: false }));
  }

  function handleSave() {
    const port = Number(form.port);
    if (!Number.isInteger(port) || port <= 0) {
      setPortError("Zadejte platné číslo portu (např. 587 nebo 465).");
      return;
    }
    setPortError(null);
    const body: EmailSettingsInput = {
      enabled: form.enabled,
      host: form.host.trim() || null,
      port,
      secure: form.secure,
      username: form.username.trim() || null,
      fromAddress: form.fromAddress.trim() || null,
      fromName: form.fromName.trim() || null,
      // Only send password when the user typed a new one; otherwise keep existing.
      ...(passwordTouched ? { password: form.password } : {}),
    };
    updateMutation.mutate(
      { data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetEmailSettingsQueryKey() });
          toast({ title: "Nastavení e-mailu uloženo" });
        },
        onError: (err: any) =>
          toast({ title: "Uložení selhalo", description: err?.message, variant: "destructive" }),
      },
    );
  }

  function handleTest() {
    const to = testTo.trim();
    if (!to) {
      setTestEmailError("Zadejte e-mail příjemce testu.");
      return;
    }
    setTestEmailError(null);
    testMutation.mutate(
      { data: { to } },
      {
        onSuccess: () =>
          toast({ title: "Testovací e-mail odeslán", description: `Odesláno na ${to}.` }),
        onError: (err: any) =>
          toast({
            title: "Odeslání testu selhalo",
            description: err?.message,
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-5 w-5" /> Odesílání e-mailů (Gmail / SMTP)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Nastavení serveru pro odesílání e-mailů (zakázkový list, přístupové údaje).
          Změny se projeví ihned i v ostrém provozu, bez nutnosti nasazení.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Načítání…</p>
        ) : (
          <>
            {source === "env" && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300">
                E-maily se nyní odesílají podle proměnných prostředí (SMTP_*). Vyplňte
                a aktivujte nastavení níže, chcete-li je spravovat odtud.
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="font-medium">Odesílat e-maily z tohoto nastavení</Label>
                <p className="text-xs text-muted-foreground">
                  Když je vypnuto, použijí se proměnné prostředí (pokud existují).
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => set("enabled", v)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Rychlé předvyplnění:</span>
              <Button type="button" variant="outline" size="sm" onClick={applyGmailPreset} className="gap-2">
                <Mail className="h-4 w-4" /> Gmail
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="smtp-host">SMTP server</Label>
                <Input
                  id="smtp-host"
                  value={form.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="smtp.gmail.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp-port">Port</Label>
                <Input
                  id="smtp-port"
                  type="number"
                  value={form.port}
                  onChange={(e) => { set("port", e.target.value); if (portError) setPortError(null); }}
                  placeholder="587"
                  aria-invalid={!!portError}
                  className={portError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {portError && (
                  <p className="text-destructive text-xs" role="alert">{portError}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="font-medium">Zabezpečené spojení (SSL/TLS)</Label>
                <p className="text-xs text-muted-foreground">
                  Zapněte pro port 465. Pro port 587 (Gmail) nechte vypnuté (STARTTLS).
                </p>
              </div>
              <Switch checked={form.secure} onCheckedChange={(v) => set("secure", v)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp-user">Uživatelské jméno (e-mail)</Label>
              <Input
                id="smtp-user"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                placeholder="vase.adresa@gmail.com"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp-pass">Heslo {form.host.includes("gmail") ? "(heslo aplikace)" : ""}</Label>
              <Input
                id="smtp-pass"
                type="password"
                value={form.password}
                onChange={(e) => {
                  set("password", e.target.value);
                  setPasswordTouched(true);
                }}
                placeholder={passwordSet ? "•••••••• (uloženo – ponechte prázdné pro zachování)" : "Zadejte heslo"}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                Pro Gmail s dvoufázovým ověřením vytvořte „Heslo aplikace“ (16 znaků) v
                nastavení účtu Google a vložte je sem.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="smtp-from">Adresa odesílatele</Label>
                <Input
                  id="smtp-from"
                  value={form.fromAddress}
                  onChange={(e) => set("fromAddress", e.target.value)}
                  placeholder="vase.adresa@gmail.com"
                />
                <p className="text-xs text-muted-foreground">
                  Nevyplníte-li, použije se uživatelské jméno.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp-fromname">Jméno odesílatele</Label>
                <Input
                  id="smtp-fromname"
                  value={form.fromName}
                  onChange={(e) => set("fromName", e.target.value)}
                  placeholder="Modvolt s.r.o."
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-2">
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? "Ukládání…" : "Uložit nastavení"}
              </Button>
            </div>

            <div className="space-y-2 border-t pt-4">
              <Label htmlFor="smtp-test">Odeslat testovací e-mail</Label>
              <p className="text-xs text-muted-foreground">
                Nejprve uložte nastavení, poté ověřte odesílání na zvolenou adresu.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 sm:max-w-xs">
                  <Input
                    id="smtp-test"
                    type="email"
                    value={testTo}
                    onChange={(e) => { setTestTo(e.target.value); if (testEmailError) setTestEmailError(null); }}
                    placeholder="prijemce@example.com"
                    aria-invalid={!!testEmailError}
                    className={testEmailError ? "border-destructive focus-visible:ring-destructive" : ""}
                  />
                  {testEmailError && (
                    <p className="text-destructive text-xs mt-1" role="alert">{testEmailError}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTest}
                  disabled={testMutation.isPending}
                  className="gap-2"
                >
                  <Send className="h-4 w-4" />
                  {testMutation.isPending ? "Odesílání…" : "Odeslat test"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EmailImportCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetEmailImportSettings({
    query: { queryKey: getGetEmailImportSettingsQueryKey() },
  });
  const { data: log } = useListEmailImportLog({
    query: { queryKey: getListEmailImportLogQueryKey() },
  });
  const updateMutation = useUpdateEmailImportSettings();
  const testMutation = useTestEmailImportConnection();
  const pollMutation = usePollEmailImport();
  const retryMutation = useRetryEmailImportLog();
  const [imapPortError, setImapPortError] = useState<string | null>(null);
  const [imapPollError, setImapPollError] = useState<string | null>(null);

  function handleRetry(id: number) {
    retryMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmailImportLogQueryKey() });
          toast({
            title: "Zpráva zařazena k opakování",
            description: "Při příštím načtení se importér pokusí zprávu zpracovat znovu.",
          });
        },
        onError: (err) => {
          toast({
            title: "Opakování se nezdařilo",
            description: err instanceof Error ? err.message : "Neznámá chyba.",
            variant: "destructive",
          });
        },
      },
    );
  }

  const [form, setForm] = useState<EmailImportForm>(EMPTY_EMAIL_IMPORT_FORM);
  const [passwordSet, setPasswordSet] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [source, setSource] = useState<"db" | "env" | "none">("none");

  useEffect(() => {
    if (!data) return;
    setForm({
      enabled: data.enabled,
      host: data.host ?? "",
      port: String(data.port ?? 993),
      secure: data.secure,
      username: data.username ?? "",
      password: "",
      folder: data.folder ?? "INBOX",
      markSeen: data.markSeen,
      pollMinutes: String(data.pollMinutes ?? 15),
    });
    setPasswordSet(data.passwordSet);
    setPasswordTouched(false);
    setSource(data.source);
  }, [data]);

  function set<K extends keyof EmailImportForm>(key: K, value: EmailImportForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function applyGmailPreset() {
    setForm((f) => ({ ...f, host: "imap.gmail.com", port: "993", secure: true }));
  }

  function handleSave() {
    const port = Number(form.port);
    if (!Number.isInteger(port) || port <= 0) {
      setImapPortError("Zadejte platné číslo portu (např. 993 nebo 143).");
      return;
    }
    setImapPortError(null);
    const pollMinutes = Number(form.pollMinutes);
    if (!Number.isInteger(pollMinutes) || pollMinutes < 1) {
      setImapPollError("Zadejte interval v minutách (min. 1).");
      return;
    }
    setImapPollError(null);
    const body: EmailImportSettingsInput = {
      enabled: form.enabled,
      host: form.host.trim() || null,
      port,
      secure: form.secure,
      username: form.username.trim() || null,
      folder: form.folder.trim() || "INBOX",
      markSeen: form.markSeen,
      pollMinutes,
      ...(passwordTouched ? { password: form.password } : {}),
    };
    updateMutation.mutate(
      { data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetEmailImportSettingsQueryKey() });
          toast({ title: "Nastavení příjmu e-mailů uloženo" });
        },
        onError: (err: any) =>
          toast({ title: "Uložení selhalo", description: err?.message, variant: "destructive" }),
      },
    );
  }

  function handleTest() {
    testMutation.mutate(
      undefined,
      {
        onSuccess: (res: any) =>
          toast({
            title: "Připojení úspěšné",
            description: `Schránka „${res.folder}“ obsahuje ${res.messages} zpráv.`,
          }),
        onError: (err: any) =>
          toast({
            title: "Připojení selhalo",
            description: err?.message,
            variant: "destructive",
          }),
      },
    );
  }

  function handlePoll() {
    pollMutation.mutate(
      undefined,
      {
        onSuccess: (res: any) => {
          queryClient.invalidateQueries({ queryKey: getListEmailImportLogQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetEmailImportSettingsQueryKey() });
          toast({
            title: "Načtení dokončeno",
            description: `Naimportováno ${res.imported}, přeskočeno ${res.skipped}, chyb ${res.failed}.`,
          });
        },
        onError: (err: any) =>
          toast({
            title: "Načtení selhalo",
            description: err?.message,
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-5 w-5" /> Příjem dokladů e-mailem (IMAP)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Automaticky stahuje přílohy (ISDOC/XML/PDF/obrázky) z poštovní schránky a
          zakládá z nich přijaté nákladové doklady. Stejná zpráva se nikdy nenaimportuje
          dvakrát. Změny se projeví ihned i v ostrém provozu.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Načítání…</p>
        ) : (
          <>
            {source === "env" && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300">
                Příjem se nyní řídí proměnnými prostředí (IMAP_*). Vyplňte a aktivujte
                nastavení níže, chcete-li je spravovat odtud.
              </div>
            )}

            {data?.lastStatus && (
              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                <div>
                  Poslední kontrola:{" "}
                  {data.lastPolledAt
                    ? new Date(data.lastPolledAt).toLocaleString("cs-CZ")
                    : "—"}
                </div>
                {data.lastError ? (
                  <div className="text-destructive mt-1">Chyba: {data.lastError}</div>
                ) : (
                  <div className="mt-1">{data.lastStatus}</div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="font-medium">Automaticky stahovat doklady</Label>
                <p className="text-xs text-muted-foreground">
                  Když je vypnuto, použijí se proměnné prostředí (pokud existují).
                </p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Rychlé předvyplnění:</span>
              <Button type="button" variant="outline" size="sm" onClick={applyGmailPreset} className="gap-2">
                <Mail className="h-4 w-4" /> Gmail
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="imap-host">IMAP server</Label>
                <Input
                  id="imap-host"
                  value={form.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="imap.gmail.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="imap-port">Port</Label>
                <Input
                  id="imap-port"
                  type="number"
                  value={form.port}
                  onChange={(e) => { set("port", e.target.value); if (imapPortError) setImapPortError(null); }}
                  placeholder="993"
                  aria-invalid={!!imapPortError}
                  className={imapPortError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {imapPortError && (
                  <p className="text-destructive text-xs" role="alert">{imapPortError}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="font-medium">Zabezpečené spojení (SSL/TLS)</Label>
                <p className="text-xs text-muted-foreground">
                  Zapněte pro port 993 (Gmail). Vypněte pro STARTTLS na portu 143.
                </p>
              </div>
              <Switch checked={form.secure} onCheckedChange={(v) => set("secure", v)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="imap-user">Uživatelské jméno (e-mail)</Label>
              <Input
                id="imap-user"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                placeholder="doklady@vasefirma.cz"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="imap-pass">Heslo {form.host.includes("gmail") ? "(heslo aplikace)" : ""}</Label>
              <Input
                id="imap-pass"
                type="password"
                value={form.password}
                onChange={(e) => {
                  set("password", e.target.value);
                  setPasswordTouched(true);
                }}
                placeholder={passwordSet ? "•••••••• (uloženo – ponechte prázdné pro zachování)" : "Zadejte heslo"}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                Pro Gmail s dvoufázovým ověřením vytvořte „Heslo aplikace“ (16 znaků) v
                nastavení účtu Google a vložte je sem.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="imap-folder">Složky / štítky</Label>
                <Input
                  id="imap-folder"
                  value={form.folder}
                  onChange={(e) => set("folder", e.target.value)}
                  placeholder="INBOX, Faktury, Dodavatelé"
                />
                <p className="text-xs text-muted-foreground">
                  Více složek / Gmail štítků oddělte čárkou (např. „INBOX,
                  Faktury, Dodavatelé/Faktury"). Názvy musí přesně odpovídat
                  štítkům v Gmailu (rozlišují velká/malá písmena). Prázdné =
                  INBOX.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="imap-poll">Interval (min)</Label>
                <Input
                  id="imap-poll"
                  type="number"
                  value={form.pollMinutes}
                  onChange={(e) => { set("pollMinutes", e.target.value); if (imapPollError) setImapPollError(null); }}
                  placeholder="15"
                  aria-invalid={!!imapPollError}
                  className={imapPollError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {imapPollError && (
                  <p className="text-destructive text-xs" role="alert">{imapPollError}</p>
                )}
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-1">
                <Label className="font-medium text-sm">Označit jako přečtené</Label>
                <Switch checked={form.markSeen} onCheckedChange={(v) => set("markSeen", v)} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-2">
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? "Ukládání…" : "Uložit nastavení"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={testMutation.isPending}
                className="gap-2"
              >
                <CheckCircle2 className="h-4 w-4" />
                {testMutation.isPending ? "Testování…" : "Otestovat připojení"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handlePoll}
                disabled={pollMutation.isPending}
                className="gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                {pollMutation.isPending ? "Načítání…" : "Načíst nyní"}
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                „Otestovat připojení" a „Načíst nyní" používají naposledy{" "}
                <strong>uložené</strong> nastavení. Po změně polí proto nejdřív
                klikněte na „Uložit nastavení".
              </p>
            </div>

            <div className="space-y-2 border-t pt-4">
              <Label>Historie importů</Label>
              {!log || log.length === 0 ? (
                <p className="text-xs text-muted-foreground">Zatím žádné zpracované zprávy.</p>
              ) : (
                <div className="space-y-2">
                  {log.map((entry: EmailImportLogEntry) => (
                    <div
                      key={entry.id}
                      className="rounded-md border p-2 text-xs flex flex-col gap-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {entry.subject || "(bez předmětu)"}
                        </span>
                        <span
                          className={
                            entry.status === "failed_permanent"
                              ? "text-destructive font-medium shrink-0"
                              : entry.status === "failed"
                                ? "text-amber-600 dark:text-amber-400 shrink-0"
                                : entry.status === "imported"
                                  ? "text-emerald-600 dark:text-emerald-400 shrink-0"
                                  : "text-muted-foreground shrink-0"
                          }
                        >
                          {IMPORT_STATUS_LABELS[entry.status] ?? entry.status}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate">
                        {entry.sender || "neznámý odesílatel"}
                        {" · "}
                        {new Date(entry.createdAt).toLocaleString("cs-CZ")}
                        {entry.status === "imported" &&
                          ` · ${entry.attachmentsImported}/${entry.attachmentsTotal} příloh`}
                        {(entry.status === "failed" ||
                          entry.status === "failed_permanent") &&
                          entry.attempts > 0 &&
                          ` · ${entry.attempts}. pokus`}
                      </div>
                      {entry.error && (
                        <div className="text-destructive">{entry.error}</div>
                      )}
                      {entry.status === "failed_permanent" && (
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-muted-foreground">
                            Automatické pokusy zastaveny — vyžaduje pozornost.
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0"
                            disabled={retryMutation.isPending}
                            onClick={() => handleRetry(entry.id)}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            Zkusit znovu
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MySessionsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading } = useListMySessions({
    query: { queryKey: getListMySessionsQueryKey() },
  });
  const deleteSession = useDeleteSession();

  const handleRevoke = (sid: string) => {
    deleteSession.mutate({ sid }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListMySessionsQueryKey() });
        toast({ title: "Přihlášení ukončeno" });
      },
      onError: (err: any) => toast({ title: "Chyba", description: err?.message, variant: "destructive" }),
    });
  };

  function DeviceIcon({ ua }: { ua: string | null }) {
    const s = ua ?? "";
    if (/iPhone|iPad|Android/i.test(s)) return <Smartphone className="w-4 h-4 shrink-0" />;
    if (/Macintosh|Mac/i.test(s)) return <Laptop className="w-4 h-4 shrink-0" />;
    return <Monitor className="w-4 h-4 shrink-0" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Monitor className="h-4 w-4" /> Moje přihlášení
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground mb-3">
          Aktivní session na všech vašich zařízeních. Jiná přihlášení můžete vzdáleně ukončit.
        </p>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map(i => <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />)}
          </div>
        ) : !sessions?.length ? (
          <p className="text-sm text-muted-foreground">Žádné aktivní session.</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div
                key={s.sid}
                className={`flex items-center gap-3 p-3 rounded-lg border ${s.isCurrent ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-border bg-muted/20"}`}
              >
                <DeviceIcon ua={s.userAgent ?? null} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{s.userAgentParsed}</span>
                    {s.isCurrent && (
                      <span className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-medium">
                        toto zařízení
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {s.ipAddress && <span>{s.ipAddress} · </span>}
                    {s.lastActiveAt
                      ? formatDistanceToNow(new Date(s.lastActiveAt), { addSuffix: true, locale: cs })
                      : "Neznámá aktivita"}
                  </div>
                </div>
                {!s.isCurrent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRevoke(s.sid)}
                    disabled={deleteSession.isPending}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="Ukončit tuto session"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityQuestionsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status } = useGetSecurityQuestionsStatus({
    query: { queryKey: getGetSecurityQuestionsStatusQueryKey() },
  });
  const save = useSetSecurityQuestions();

  const [currentPassword, setCurrentPassword] = useState("");
  const [questions, setQuestions] = useState(["", "", ""]);
  const [answers, setAnswers] = useState(["", "", ""]);
  const [formError, setFormError] = useState<string | null>(null);

  const configured = status?.configured ?? false;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword) {
      setFormError("Zadejte své aktuální heslo.");
      return;
    }
    if (questions.some((q) => !q.trim()) || answers.some((a) => !a.trim())) {
      setFormError("Vyplňte všechny 3 otázky a odpovědi.");
      return;
    }
    setFormError(null);
    save.mutate(
      {
        data: {
          currentPassword,
          questions: questions.map((q, i) => ({ question: q.trim(), answer: answers[i] })),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Bezpečnostní otázky uloženy" });
          setCurrentPassword("");
          setAnswers(["", "", ""]);
          setFormError(null);
          void queryClient.invalidateQueries({ queryKey: getGetSecurityQuestionsStatusQueryKey() });
        },
        onError: (err: unknown) => {
          const msg = (err as { message?: string })?.message;
          setFormError(msg?.includes("heslo") ? "Nesprávné aktuální heslo." : "Zkontrolujte zadané údaje a zkuste to znovu.");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldQuestion className="h-4 w-4" /> Bezpečnostní otázky (obnova hesla)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-2 text-sm">
          {configured ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
              <CheckCircle2 className="h-4 w-4" /> Nastaveno
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <XCircle className="h-4 w-4" /> Zatím nenastaveno
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Nastavte si 3 vlastní otázky a odpovědi. Pokud zapomenete heslo, budete
          si ho moci na přihlašovací obrazovce obnovit správným zodpovězením všech
          tří otázek. Odpovědi se ukládají zabezpečeně (zašifrovaně) a nelze je
          zpětně zobrazit.
        </p>
        <form onSubmit={handleSave} className="space-y-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <Label className="text-xs font-medium text-muted-foreground">Otázka {i + 1}</Label>
              <Input
                value={questions[i]}
                onChange={(e) => setQuestions((q) => q.map((v, j) => (j === i ? e.target.value : v)))}
                placeholder="Např. Jak se jmenovalo vaše první auto?"
              />
              <Input
                value={answers[i]}
                onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                placeholder="Odpověď"
                autoComplete="off"
              />
            </div>
          ))}
          <div>
            <Label className="text-sm font-medium block mb-1">Vaše aktuální heslo *</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); if (formError) setFormError(null); }}
              autoComplete="current-password"
              placeholder="Pro potvrzení změny"
            />
          </div>
          {formError && (
            <p className="text-destructive text-sm" role="alert">{formError}</p>
          )}
          <Button type="submit" disabled={save.isPending} className="gap-2 h-11">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {configured ? "Změnit otázky" : "Uložit otázky"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LeaveSettingsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useGetLeaveSettings({
    query: { queryKey: getGetLeaveSettingsQueryKey() },
  });
  const update = useUpdateLeaveSettings();

  const [vacation, setVacation] = useState("");
  const [sick, setSick] = useState("");
  const [other, setOther] = useState("");

  useEffect(() => {
    if (settings) {
      setVacation(String(settings.vacationYearlyCap));
      setSick(String(settings.sickYearlyCap));
      setOther(String(settings.otherYearlyCap));
    }
  }, [settings]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const v = parseInt(vacation, 10);
    const s = parseInt(sick, 10);
    const o = parseInt(other, 10);
    if (!v || !s || !o || v < 1 || s < 1 || o < 1) {
      toast({ title: "Limity musí být celá kladná čísla", variant: "destructive" });
      return;
    }
    update.mutate(
      { data: { vacationYearlyCap: v, sickYearlyCap: s, otherYearlyCap: o } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetLeaveSettingsQueryKey() });
          toast({ title: "Limity dovolených uloženy" });
        },
        onError: () => {
          toast({ title: "Nepodařilo se uložit limity", variant: "destructive" });
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-4 w-4" /> Roční limity dovolených
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Maximální počet dní za rok na pracovníka pro každý typ nepřítomnosti.
          Při překročení limitu API vrátí chybu a záznam nebude uložen.
        </p>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">🏖 Dovolená (dní/rok)</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={vacation}
                onChange={(e) => setVacation(e.target.value)}
                placeholder="25"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">🤒 Nemoc (dní/rok)</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={sick}
                onChange={(e) => setSick(e.target.value)}
                placeholder="60"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">📅 Jiné volno (dní/rok)</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="30"
              />
            </div>
          </div>
          <Button type="submit" disabled={update.isPending} className="gap-2 h-11">
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Uložit limity
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { can } = useAuth();
  const [companyName, setCompanyName] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [info, setInfo] = useState("");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [textColor, setTextColor] = useState("");
  const [uiScale, setUiScale] = useState<number>(DEFAULT_UI_SCALE);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sigRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = loadCompanySettings();
    setCompanyName(s.name);
    setLogoDataUrl(s.logoDataUrl);
    setInfo(s.info);
    setSignatureDataUrl(s.signatureDataUrl);
    setTextColor(s.textColor);
    setUiScale(s.uiScale);
  }, []);

  function persist(next: Partial<CompanySettings>) {
    const merged: CompanySettings = {
      name: next.name ?? companyName,
      logoDataUrl: next.logoDataUrl ?? logoDataUrl,
      info: next.info ?? info,
      signatureDataUrl: next.signatureDataUrl ?? signatureDataUrl,
      textColor: next.textColor ?? textColor,
      uiScale: next.uiScale ?? uiScale,
    };
    saveCompanySettings(merged);
    setSavedAt(Date.now());
  }

  function processLogoFile(file: File | undefined) {
    if (!file) return;
    setLogoError(null);
    if (!/^image\/(png|jpeg|jpg)$/i.test(file.type)) {
      setLogoError("Použijte obrázek PNG nebo JPG.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo je větší než 500 kB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setLogoDataUrl(url);
      persist({ logoDataUrl: url });
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    processLogoFile(e.target.files?.[0]);
  }

  function processSignatureFile(file: File | undefined) {
    if (!file) return;
    setSignatureError(null);
    if (!/^image\/(png|jpeg|jpg)$/i.test(file.type)) {
      setSignatureError("Použijte obrázek PNG nebo JPG.");
      return;
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      setSignatureError("Podpis je větší než 500 kB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setSignatureDataUrl(url);
      persist({ signatureDataUrl: url });
    };
    reader.readAsDataURL(file);
    if (sigRef.current) sigRef.current.value = "";
  }

  function onSignatureFile(e: React.ChangeEvent<HTMLInputElement>) {
    processSignatureFile(e.target.files?.[0]);
  }

  function clearLogo() {
    setLogoDataUrl("");
    persist({ logoDataUrl: "" });
  }

  function clearSignature() {
    setSignatureDataUrl("");
    persist({ signatureDataUrl: "" });
  }

  function onTextColorChange(value: string) {
    setTextColor(value);
    applyTextColor(value);
    persist({ textColor: value });
  }

  function resetTextColor() {
    setTextColor("");
    applyTextColor("");
    persist({ textColor: "" });
  }

  function onUiScaleChange(value: number) {
    setUiScale(value);
    applyUiScale(value);
    persist({ uiScale: value });
  }

  const themes = [
    { value: "light", label: "Světlý", icon: Sun },
    { value: "dark", label: "Tmavý", icon: Moon },
    { value: "system", label: "Systémový", icon: Monitor },
  ];

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto w-full space-y-6">
      <h1 className="text-2xl font-bold">Nastavení</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sun className="h-5 w-5" /> Vzhled aplikace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Vyberte barevný režim zobrazení.</p>
            <div className="grid grid-cols-3 gap-3">
              {themes.map(({ value, label, icon: Icon }) => {
                const isActive = theme === value;
                return (
                  <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                      isActive
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-7 w-7" />
                    <span className="text-sm font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2">
              <Palette className="h-4 w-4" /> Barva textu
            </Label>
            <p className="text-sm text-muted-foreground">
              Vlastní barva hlavního textu aplikace. Ponechte výchozí pro standardní vzhled.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={textColor || "#0f172a"}
                onChange={(e) => onTextColorChange(e.target.value)}
                className="h-10 w-14 rounded-md border bg-card cursor-pointer p-1"
                aria-label="Barva textu"
              />
              <Input
                value={textColor}
                onChange={(e) => onTextColorChange(e.target.value)}
                placeholder="#0f172a"
                className="max-w-[160px] font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetTextColor}
                className="text-muted-foreground"
              >
                Výchozí
              </Button>
            </div>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2">
              <ZoomIn className="h-4 w-4" /> Velikost zobrazení
            </Label>
            <p className="text-sm text-muted-foreground">
              Zvětší nebo zmenší celé rozhraní (text i rozestupy) na počítači i
              na telefonu. Pomáhá, když se na menších obrazovkách nevejde celé
              menu nebo je text špatně čitelný. Nastavení se uloží do tohoto
              prohlížeče.
            </p>
            <div className="grid grid-cols-5 gap-2">
              {UI_SCALE_OPTIONS.map(({ value, label }) => {
                const active = uiScale === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onUiScaleChange(value)}
                    className={`flex flex-col items-center justify-center gap-1 px-1 py-2 rounded-lg border-2 transition-all ${
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <span className="text-xs font-medium">{label}</span>
                    <span className="text-[10px] opacity-70">
                      {Math.round(value * 100)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-5 w-5" /> Firma a dokumenty
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Název, logo, informace o firmě a podpis se použijí na vytištěných a
            zasílaných dokumentech (zakázkový list, exporty).
          </p>

          <div className="space-y-2">
            <Label htmlFor="company-name">Název firmy</Label>
            <Input
              id="company-name"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onBlur={() => persist({ name: companyName })}
              placeholder="Např. Stavby Novák s.r.o."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="company-info">Informace o firmě</Label>
            <Textarea
              id="company-info"
              value={info}
              onChange={(e) => setInfo(e.target.value)}
              onBlur={() => persist({ info })}
              rows={4}
              placeholder={"IČO, DIČ, adresa, telefon, e-mail, číslo účtu…"}
            />
            <p className="text-xs text-muted-foreground">
              Zobrazí se na dokumentech pod názvem firmy.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {logoDataUrl ? (
                <div className="h-16 w-24 border rounded-md bg-muted/30 flex items-center justify-center overflow-hidden">
                  <img
                    src={logoDataUrl}
                    alt="Logo firmy"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-16 w-24 border border-dashed rounded-md flex items-center justify-center text-xs text-muted-foreground">
                  Bez loga
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {logoDataUrl ? "Změnit logo" : "Nahrát logo"}
                </Button>
                {logoDataUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearLogo}
                    className="gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                    Odebrat
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={onLogoFile}
              />
            </div>
            <FileDropZone
              onFiles={(files) => processLogoFile(files[0])}
              accept="image/png,image/jpeg"
              multiple={false}
              label="Sem přetáhněte logo (PNG nebo JPG)"
            />
            <p className="text-xs text-muted-foreground">
              PNG nebo JPG, max 500 kB. Doporučeno: průhledné PNG.
            </p>
            {logoError && <p className="text-xs text-destructive">{logoError}</p>}
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2">
              <PenLine className="h-4 w-4" /> Podpis na dokumenty
            </Label>
            <div className="flex items-center gap-3">
              {signatureDataUrl ? (
                <div className="h-20 w-40 border rounded-md bg-white flex items-center justify-center overflow-hidden">
                  <img
                    src={signatureDataUrl}
                    alt="Podpis"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-20 w-40 border border-dashed rounded-md flex items-center justify-center text-xs text-muted-foreground text-center px-2">
                  Bez podpisu
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => sigRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {signatureDataUrl ? "Změnit podpis" : "Nahrát podpis"}
                </Button>
                {signatureDataUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearSignature}
                    className="gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                    Odebrat
                  </Button>
                )}
              </div>
              <input
                ref={sigRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={onSignatureFile}
              />
            </div>
            <FileDropZone
              onFiles={(files) => processSignatureFile(files[0])}
              accept="image/png,image/jpeg"
              multiple={false}
              label="Sem přetáhněte podpis (PNG nebo JPG)"
            />
            <p className="text-xs text-muted-foreground">
              PNG nebo JPG, max 500 kB. Použije se jako podpis zhotovitele na zakázkovém listu.
            </p>
            {signatureError && (
              <p className="text-xs text-destructive">{signatureError}</p>
            )}
          </div>

          {savedAt && <p className="text-xs text-muted-foreground">Uloženo.</p>}
        </CardContent>
      </Card>

      {can("manageUsers") && <EmailSettingsCard />}

      {can("manageUsers") && <EmailImportCard />}

      {can("manageUsers") && <BackupCard />}

      <MySessionsCard />

      {can("manageUsers") && <BackupScheduleCard />}

      {can("manageUsers") && <SecurityQuestionsCard />}

      {can("manageUsers") && <LeaveSettingsCard />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4" /> Obnovit aplikaci
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pokud aplikace zobrazuje starou verzi, neaktualizuje se nebo se chová
            divně, vymažte uloženou mezipaměť a načtěte ji znovu ze serveru.
          </p>
          <Button
            type="button"
            variant="outline"
            className="gap-2 h-11"
            onClick={() => { void hardRefreshApp(); }}
          >
            <RefreshCw className="h-4 w-4" /> Vymazat mezipaměť a obnovit
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
