import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor, Building2, Upload, X, Palette, PenLine, Mail, Send, Save, Database, Download, RefreshCw, CheckCircle2, XCircle, Loader2 } from "lucide-react";
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
  useListBackups,
  useCreateBackup,
  getListBackupsQueryKey,
  downloadBackup,
  type Backup,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  loadCompanySettings,
  saveCompanySettings,
  applyTextColor,
  type CompanySettings,
} from "@/lib/company-settings";

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

function BackupCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListBackups({
    query: { queryKey: getListBackupsQueryKey() },
  });
  const createMutation = useCreateBackup();
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

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
              <div key={backup.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <BackupStatusBadge status={backup.status} />
                    <span className="text-xs text-muted-foreground">
                      {backup.trigger === "auto" ? "automatická" : "ruční"}
                    </span>
                  </div>
                  <div className="truncate text-sm font-medium">{formatDateTime(backup.createdAt)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(backup.sizeBytes)}
                    {backup.error ? ` · ${backup.error}` : ""}
                  </div>
                </div>
                {backup.status === "success" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={downloadingId === backup.id}
                    onClick={() => handleDownload(backup)}
                  >
                    {downloadingId === backup.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Stáhnout
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
      toast({ title: "Neplatný port", variant: "destructive" });
      return;
    }
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
      toast({ title: "Zadejte e-mail příjemce testu", variant: "destructive" });
      return;
    }
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
                  onChange={(e) => set("port", e.target.value)}
                  placeholder="587"
                />
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
                <Input
                  id="smtp-test"
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="prijemce@example.com"
                  className="sm:max-w-xs"
                />
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

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { can } = useAuth();
  const [companyName, setCompanyName] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [info, setInfo] = useState("");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [textColor, setTextColor] = useState("");
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
  }, []);

  function persist(next: Partial<CompanySettings>) {
    const merged: CompanySettings = {
      name: next.name ?? companyName,
      logoDataUrl: next.logoDataUrl ?? logoDataUrl,
      info: next.info ?? info,
      signatureDataUrl: next.signatureDataUrl ?? signatureDataUrl,
      textColor: next.textColor ?? textColor,
    };
    saveCompanySettings(merged);
    setSavedAt(Date.now());
  }

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
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

  function onSignatureFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
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

      {can("manageUsers") && <BackupCard />}
    </div>
  );
}
