import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetEmailImportStatus,
  getGetEmailImportStatusQueryKey,
  useDisconnectEmailImport,
  useListEmailImportLabels,
  getListEmailImportLabelsQueryKey,
  useUpdateEmailImportLabelSettings,
  useSyncEmailImport,
  useListEmailImportMessages,
  getListEmailImportMessagesQueryKey,
  useImportEmailImportMessage,
  useIgnoreEmailImportMessage,
  useReprocessEmailImportMessage,
  useGetEmailImportMessage,
  getGetEmailImportMessageQueryKey,
  type EmailImportMessage,
  type EmailImportAttachment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Mail,
  CheckCircle2,
  XCircle,
  Loader2,
  Link2,
  Unlink,
  RefreshCw,
  Tag,
  Save,
  Inbox,
  FileDown,
  Ban,
  RotateCcw,
  AlertTriangle,
  Paperclip,
  FileText,
  ChevronRight,
} from "lucide-react";

const CONNECT_URL = "/api/billing/email-import/connect";

const STATUS_LABELS: Record<string, string> = {
  new: "Nové",
  imported: "Importováno",
  ignored: "Ignorováno",
  error: "Chyba",
};

const STATUS_FILTERS = [
  { value: "all", label: "Vše" },
  { value: "new", label: "Nové" },
  { value: "imported", label: "Importováno" },
  { value: "ignored", label: "Ignorováno" },
  { value: "error", label: "Chyby" },
] as const;

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function BillingEmailImport() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // One-time toast from the OAuth callback redirect (?emailImport=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("emailImport");
    if (!result) return;
    if (result === "connected") {
      toast({ title: "E-mailový účet připojen" });
    } else if (result === "error") {
      const reason = params.get("reason");
      toast({
        title: "Připojení účtu selhalo",
        description: reason ?? undefined,
        variant: "destructive",
      });
    }
    // Strip the query params so a refresh doesn't re-toast.
    window.history.replaceState({}, "", window.location.pathname);
    invalidateData(queryClient, "emailImport");
  }, [toast, queryClient]);

  const { data: status, isLoading: statusLoading } = useGetEmailImportStatus({
    query: { queryKey: getGetEmailImportStatusQueryKey() },
  });

  const connected = status?.connected ?? false;
  const account = status?.account ?? null;

  const disconnect = useDisconnectEmailImport();
  const sync = useSyncEmailImport();

  const refreshStatus = () =>
    invalidateData(queryClient, "emailImport");

  const handleConnect = () => {
    window.location.href = CONNECT_URL;
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Účet odpojen" });
        refreshStatus();
      },
      onError: (err) =>
        toast({
          title: "Odpojení selhalo",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    });
  };

  const handleSync = () => {
    sync.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "Synchronizace dokončena",
          description: `Načteno ${res.fetched}, nových ${res.newMessages}.`,
        });
        invalidateData(queryClient, "emailImport");
      },
      onError: (err) =>
        toast({
          title: "Synchronizace selhala",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/billing")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> Fakturace
      </Button>
      <div className="flex items-center gap-3 mb-6">
        <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2.5 rounded-full text-emerald-600 dark:text-emerald-300">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold">Import dokladů z e-mailu</h1>
      </div>

      {statusLoading || !status ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !status.configured ? (
        <NotConfigured missing={status.missing} />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2 className="h-5 w-5" /> Připojení účtu
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border divide-y">
                <StatusRow
                  label="Stav"
                  value={connected ? "Připojeno" : "Nepřipojeno"}
                  ok={connected}
                />
                <div className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-muted-foreground">E-mailová schránka</span>
                  <span className="font-mono text-xs">
                    {account?.emailAddress ?? "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Připojeno dne</span>
                  <span>{fmtDateTime(account?.connectedAt)}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Poslední synchronizace</span>
                  <span>{fmtDateTime(account?.lastSyncAt)}</span>
                </div>
                {account?.lastSyncError && (
                  <div className="flex items-start gap-2 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{account.lastSyncError}</span>
                  </div>
                )}
              </div>

              <p className="text-sm text-muted-foreground">
                Připojí se účet Google (Gmail / Workspace) pouze pro čtení. Z přijatých
                e-mailů se stahují přílohy (PDF, fotografie) a zakládají se jako přijaté
                doklady ke kontrole.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                {connected ? (
                  <>
                    <Button onClick={handleSync} disabled={sync.isPending}>
                      {sync.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      Synchronizovat nyní
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDisconnect}
                      disabled={disconnect.isPending}
                    >
                      {disconnect.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Unlink className="h-4 w-4 mr-2" />
                      )}
                      Odpojit účet
                    </Button>
                  </>
                ) : (
                  <Button onClick={handleConnect}>
                    <Link2 className="h-4 w-4 mr-2" /> Připojit účet Google
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {connected && account && (
            <LabelSettings
              accountLabels={account.labels}
              labelAfterImport={account.labelAfterImport}
            />
          )}

          {connected && <MessagesSection />}
        </div>
      )}
    </div>
  );
}

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <XCircle className="h-5 w-5 text-muted-foreground" /> Není nakonfigurováno
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Import dokladů z e-mailu je volitelná funkce. Aplikace funguje i bez ní –
          doklady lze nahrávat ručně. Pro zapnutí nastavte na serveru proměnné
          prostředí pro OAuth aplikaci Google a šifrovací klíč.
        </p>
        {missing.length > 0 && (
          <div className="rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Chybějící proměnné prostředí:
            </p>
            <ul className="space-y-1">
              {missing.map((m) => (
                <li key={m} className="flex items-center gap-2 text-sm">
                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <code className="text-xs">{m}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Potřebné proměnné: <code>GOOGLE_CLIENT_ID</code>,{" "}
          <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REDIRECT_URI</code> a{" "}
          <code>TOKEN_ENCRYPTION_KEY</code>.
        </p>
      </CardContent>
    </Card>
  );
}

function LabelSettings({
  accountLabels,
  labelAfterImport,
}: {
  accountLabels: string[];
  labelAfterImport: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: labelList, isLoading: labelsLoading } = useListEmailImportLabels({
    query: { queryKey: getListEmailImportLabelsQueryKey() },
  });
  const update = useUpdateEmailImportLabelSettings();

  const [selected, setSelected] = useState<string[]>(accountLabels);
  const [afterImport, setAfterImport] = useState<boolean>(labelAfterImport);

  useEffect(() => {
    setSelected(accountLabels);
  }, [accountLabels]);
  useEffect(() => {
    setAfterImport(labelAfterImport);
  }, [labelAfterImport]);

  const labels = labelList?.labels ?? [];

  // Show selected ids that no longer exist in Gmail so the admin can drop them.
  const orphanLabels = useMemo(
    () => selected.filter((id) => !labels.some((l) => l.id === id)),
    [selected, labels],
  );

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );

  const handleSave = () => {
    update.mutate(
      { data: { labels: selected, labelAfterImport: afterImport } },
      {
        onSuccess: () => {
          toast({ title: "Nastavení uloženo" });
          invalidateData(queryClient, "emailImport");
        },
        onError: (err) =>
          toast({
            title: "Uložení selhalo",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-5 w-5" /> Štítky a filtrování
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Vyberte štítky Gmailu, ze kterých se mají stahovat doklady. Pokud nevyberete
          žádný štítek, prohledá se celá schránka (pouze e-maily s přílohami).
        </p>

        {labelsLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nepodařilo se načíst štítky ze schránky.
          </p>
        ) : (
          <div className="rounded-md border max-h-72 overflow-y-auto divide-y">
            {labels.map((label) => (
              <label
                key={label.id}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40"
              >
                <Checkbox
                  checked={selected.includes(label.id)}
                  onCheckedChange={(v) => toggle(label.id, v === true)}
                />
                <span className="text-sm flex-1">{label.name}</span>
                {label.type === "system" && (
                  <Badge variant="secondary" className="text-[10px]">
                    systémový
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}

        {orphanLabels.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 text-sm">
            <p className="text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" /> Vybrané štítky, které již ve schránce
              nejsou:
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {orphanLabels.map((id) => (
                <Badge key={id} variant="outline" className="font-mono text-[10px]">
                  {id}
                  <button
                    type="button"
                    className="ml-1.5 text-muted-foreground hover:text-foreground"
                    onClick={() => toggle(id, false)}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="font-medium">Označit zpracované e-maily štítkem</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Po importu přidá zprávě štítek „Stavba/Importováno“, aby se nezpracovávala
              znovu.
            </p>
          </div>
          <Switch checked={afterImport} onCheckedChange={setAfterImport} />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Uložit nastavení
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MessagesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const params =
    filter === "all"
      ? undefined
      : { status: filter as "new" | "imported" | "ignored" | "error" };

  const { data: messages, isLoading } = useListEmailImportMessages(params, {
    query: { queryKey: getListEmailImportMessagesQueryKey(params) },
  });

  const importMsg = useImportEmailImportMessage();
  const ignoreMsg = useIgnoreEmailImportMessage();
  const reprocessMsg = useReprocessEmailImportMessage();

  const invalidate = () => invalidateData(queryClient, "emailImport");

  const handleImport = (id: number) =>
    importMsg.mutate(
      { id },
      {
        onSuccess: (res) => {
          toast({
            title: "Doklady importovány",
            description: `Importováno ${res.imported}, přeskočeno ${res.skipped}, duplicit ${res.duplicates}.`,
          });
          invalidate();
        },
        onError: (err) =>
          toast({
            title: "Import selhal",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    );

  const handleIgnore = (id: number) =>
    ignoreMsg.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Zpráva ignorována" });
          invalidate();
        },
        onError: () => toast({ title: "Akce selhala", variant: "destructive" }),
      },
    );

  const handleReprocess = (id: number) =>
    reprocessMsg.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Zpráva vrácena ke zpracování" });
          invalidate();
        },
        onError: () => toast({ title: "Akce selhala", variant: "destructive" }),
      },
    );

  const pendingId =
    (importMsg.isPending && importMsg.variables?.id) ||
    (ignoreMsg.isPending && ignoreMsg.variables?.id) ||
    (reprocessMsg.isPending && reprocessMsg.variables?.id) ||
    null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="h-5 w-5" /> Zprávy
        </CardTitle>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : !messages || messages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Žádné zprávy. Spusťte synchronizaci pro načtení e-mailů.
          </p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                busy={pendingId === m.id}
                onImport={() => handleImport(m.id)}
                onIgnore={() => handleIgnore(m.id)}
                onReprocess={() => handleReprocess(m.id)}
                onOpenDetail={() => setDetailId(m.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
      <MessageDetailDialog
        messageId={detailId}
        onClose={() => setDetailId(null)}
      />
    </Card>
  );
}

function MessageDetailDialog({
  messageId,
  onClose,
}: {
  messageId: number | null;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useGetEmailImportMessage(messageId ?? 0, {
    query: {
      enabled: messageId != null,
      queryKey: getGetEmailImportMessageQueryKey(messageId ?? 0),
    },
  });

  return (
    <Dialog open={messageId != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base pr-6">
            <Mail className="h-5 w-5 shrink-0" />
            <span className="truncate">
              {detail?.subject || "(bez předmětu)"}
            </span>
          </DialogTitle>
        </DialogHeader>

        {isLoading || !detail ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border divide-y text-sm">
              <DetailRow label="Odesílatel" value={detail.fromName || detail.fromAddress || "—"} />
              {detail.fromName && detail.fromAddress && (
                <DetailRow label="E-mail" value={detail.fromAddress} mono />
              )}
              <DetailRow label="Datum" value={fmtDateTime(detail.sentAt)} />
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-muted-foreground">Stav</span>
                <StatusBadge status={detail.status} />
              </div>
            </div>

            {detail.snippet && (
              <p className="text-sm text-muted-foreground italic border-l-2 pl-3">
                {detail.snippet}
              </p>
            )}

            {detail.error && (
              <p className="text-sm text-destructive flex items-start gap-1.5">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {detail.error}
              </p>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5" />
                Přílohy ({detail.attachments.length})
              </p>
              {detail.attachments.length === 0 ? (
                <p className="text-sm text-muted-foreground">Žádné přílohy.</p>
              ) : (
                <div className="rounded-md border divide-y">
                  {detail.attachments.map((a) => (
                    <AttachmentRow key={a.id} attachment={a} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttachmentRow({ attachment: a }: { attachment: EmailImportAttachment }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <FileText className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{a.fileName || "(bez názvu)"}</p>
        <p className="text-xs text-muted-foreground">
          {a.contentType || "neznámý typ"}
          {a.size != null ? ` · ${formatBytes(a.size)}` : ""}
        </p>
        {a.skipped && a.skipReason && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
            {a.skipReason}
          </p>
        )}
      </div>
      {a.billingDocumentId != null ? (
        <Badge className="bg-emerald-600 hover:bg-emerald-600 shrink-0 text-[10px]">
          <CheckCircle2 className="h-3 w-3 mr-1" /> Doklad #{a.billingDocumentId}
        </Badge>
      ) : a.skipped ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          Přeskočeno
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          Ke zpracování
        </Badge>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

function MessageRow({
  message: m,
  busy,
  onImport,
  onIgnore,
  onReprocess,
  onOpenDetail,
}: {
  message: EmailImportMessage;
  busy: boolean;
  onImport: () => void;
  onIgnore: () => void;
  onReprocess: () => void;
  onOpenDetail: () => void;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onOpenDetail}
          className="min-w-0 flex-1 text-left group"
          aria-label="Zobrazit detail zprávy"
        >
          <p className="font-medium text-sm truncate group-hover:underline flex items-center gap-1">
            {m.subject || "(bez předmětu)"}
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {m.fromName || m.fromAddress || "—"}
          </p>
          {m.snippet && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {m.snippet}
            </p>
          )}
        </button>
        <StatusBadge status={m.status} />
      </div>

      <div className="flex items-center justify-between gap-3 mt-2">
        <div className="text-xs text-muted-foreground flex items-center gap-3">
          <span>{fmtDateTime(m.sentAt)}</span>
          <span>
            {m.attachmentCount}{" "}
            {m.attachmentCount === 1 ? "příloha" : "příloh"}
            {m.importedCount > 0 ? ` · ${m.importedCount} importováno` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {(m.status === "new" || m.status === "error") && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={onImport}
                disabled={busy}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" /> Importovat
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={onIgnore}
                disabled={busy}
              >
                <Ban className="h-3.5 w-3.5 mr-1" /> Ignorovat
              </Button>
            </>
          )}
          {(m.status === "imported" || m.status === "ignored") && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={onReprocess}
              disabled={busy}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Znovu
            </Button>
          )}
        </div>
      </div>

      {m.error && (
        <p className="text-xs text-destructive mt-2 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {m.error}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;
  if (status === "imported") {
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600 shrink-0">
        <CheckCircle2 className="h-3 w-3 mr-1" /> {label}
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="destructive" className="shrink-0">
        <XCircle className="h-3 w-3 mr-1" /> {label}
      </Badge>
    );
  }
  if (status === "ignored") {
    return (
      <Badge variant="secondary" className="shrink-0">
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      {label}
    </Badge>
  );
}

function StatusRow({
  label,
  value,
  ok,
  neutral,
}: {
  label: string;
  value: string;
  ok: boolean;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-medium ${
          neutral
            ? "text-amber-600 dark:text-amber-400"
            : ok
              ? "text-green-700 dark:text-green-400"
              : "text-muted-foreground"
        }`}
      >
        {ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : neutral ? null : (
          <XCircle className="h-4 w-4" />
        )}
        {value}
      </span>
    </div>
  );
}
