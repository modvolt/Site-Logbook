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
  ChevronDown,
  Settings,
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

  const refreshStatus = () => invalidateData(queryClient, "emailImport");

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
        <div className="bg-teal-100 dark:bg-teal-900/30 p-2.5 rounded-full text-teal-600 dark:text-teal-300">
          <Mail className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Import z e-mailu</h1>
          <p className="text-sm text-muted-foreground">
            Automatické stahování příloh z Gmailu / Google Workspace
          </p>
        </div>
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
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6 text-center space-y-4">
          <div className="mx-auto bg-muted rounded-full p-4 w-fit">
            <Mail className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-1">E-mailový import není zapnutý</h2>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Tato funkce umožňuje automaticky stahovat přílohy z Gmailu a přidávat je
              jako přijaté doklady ke kontrole. Doklady lze kdykoliv nahrávat i ručně.
            </p>
          </div>
          <div className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground text-left max-w-sm mx-auto">
            <p className="font-medium text-foreground mb-1 flex items-center gap-1.5">
              <Settings className="h-4 w-4" /> Pro zapnutí je potřeba:
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-xs">
              <li>Vytvořit OAuth aplikaci v Google Cloud Console</li>
              <li>Nastavit proměnné prostředí na serveru</li>
              <li>Připojit e-mailový účet v aplikaci</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            Podrobnosti najdete v dokumentaci nasazení (DEPLOYMENT.md).
          </p>
        </CardContent>
      </Card>

      {missing.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground w-full text-left"
              onClick={() => setShowDetails((v) => !v)}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showDetails ? "rotate-180" : ""}`}
              />
              Technické detaily pro administrátora
            </button>
            {showDetails && (
              <div className="mt-3 rounded-md border p-3">
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
                <p className="text-xs text-muted-foreground mt-3">
                  Potřebné proměnné: <code>GOOGLE_CLIENT_ID</code>,{" "}
                  <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REDIRECT_URI</code> a{" "}
                  <code>TOKEN_ENCRYPTION_KEY</code>.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
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
              Po importu přidá zprávě štítek „Stavba/Importováno", aby se nezpracovávala
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
        onError: () =>
          toast({ title: "Operace selhala", variant: "destructive" }),
      },
    );

  const handleReprocess = (id: number) =>
    reprocessMsg.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Zpráva zařazena ke zpracování" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Operace selhala", variant: "destructive" }),
      },
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="h-5 w-5" /> E-mailové zprávy
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-48">
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

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !messages || messages.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Mail className="h-8 w-8 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Žádné zprávy k zobrazení.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className="border rounded-lg overflow-hidden"
              >
                <div className="p-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm truncate">
                        {msg.subject || "(bez předmětu)"}
                      </p>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          msg.status === "imported"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : msg.status === "error"
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                              : msg.status === "ignored"
                                ? "bg-muted text-muted-foreground"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                        }`}
                      >
                        {STATUS_LABELS[msg.status] ?? msg.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {msg.fromAddress || "—"} · {fmtDateTime(msg.sentAt)}
                    </p>
                    {msg.error && (
                      <p className="text-xs text-destructive mt-1">{msg.error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {msg.status === "new" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => handleImport(msg.id)}
                          disabled={importMsg.isPending}
                        >
                          <FileDown className="h-3.5 w-3.5 mr-1" />
                          Importovat
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs text-muted-foreground"
                          onClick={() => handleIgnore(msg.id)}
                          disabled={ignoreMsg.isPending}
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    {(msg.status === "ignored" || msg.status === "error") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => handleReprocess(msg.id)}
                        disabled={reprocessMsg.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        Znovu
                      </Button>
                    )}
                    {msg.attachmentCount > 0 && (
                      <button
                        type="button"
                        className="h-8 px-2 text-muted-foreground hover:text-foreground text-xs flex items-center gap-1"
                        onClick={() =>
                          setDetailId(detailId === msg.id ? null : msg.id)
                        }
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        {msg.attachmentCount}
                        <ChevronRight
                          className={`h-3.5 w-3.5 transition-transform ${
                            detailId === msg.id ? "rotate-90" : ""
                          }`}
                        />
                      </button>
                    )}
                  </div>
                </div>
                {detailId === msg.id && (
                  <MessageAttachments messageId={msg.id} />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {detailId !== null && (
        <Dialog open onOpenChange={() => setDetailId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Přílohy zprávy</DialogTitle>
            </DialogHeader>
            <MessageAttachments messageId={detailId} />
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

function MessageAttachments({ messageId }: { messageId: number }) {
  const { data, isLoading } = useGetEmailImportMessage(messageId, {
    query: { queryKey: getGetEmailImportMessageQueryKey(messageId) },
  });

  if (isLoading) return <Skeleton className="h-20 m-3" />;
  if (!data) return null;

  const attachments = data.attachments ?? [];
  if (attachments.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-3 pb-3">Žádné přílohy.</p>
    );
  }

  return (
    <div className="border-t divide-y">
      {attachments.map((att: EmailImportAttachment) => (
        <div key={att.id} className="px-3 py-2 flex items-center gap-2 text-xs">
          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate">{att.fileName || "Příloha"}</span>
          <span className="text-muted-foreground shrink-0">{att.contentType}</span>
          {att.billingDocumentId && (
            <span className="text-emerald-600 dark:text-emerald-400 shrink-0">
              ✓ importováno
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-medium ${
          ok ? "text-green-700 dark:text-green-400" : "text-muted-foreground"
        }`}
      >
        {ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <XCircle className="h-4 w-4" />
        )}
        {value}
      </span>
    </div>
  );
}
