import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListCustomers,
  useListCustomerSites,
  useListDeviceCredentials,
  useCreateDeviceCredential,
  useUpdateDeviceCredential,
  useDeleteDeviceCredential,
  getListCustomersQueryKey,
  getListCustomerSitesQueryKey,
  getListDeviceCredentialsQueryKey,
  type DeviceCredential,
  type JablotronUser,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  KeyRound, Plus, Save, X, Edit3, Trash2, Eye, EyeOff, Copy,
  Building2, MapPin, Server, User as UserIcon, Mail, FileText,
  Network, Hash, ScanLine, Users, CreditCard, FileDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BarcodeScanner } from "@/components/barcode-scanner";

const DEVICE_TYPES = [
  "NVR",
  "Kamera",
  "Router",
  "Switch",
  "Access system",
  "Jablotron",
  "Loxon",
] as const;

const CUSTOM_TYPE = "__custom__";

const USER_DEVICE_TYPES = ["Jablotron", "Access system", "Loxon"];
const supportsUsers = (type: string) =>
  USER_DEVICE_TYPES.includes(type.trim());

const IP_PREFIXES: { label: string; prefix: string }[] = [
  { label: "10.0.0.x", prefix: "10.0.0." },
  { label: "192.168.1.X", prefix: "192.168.1." },
  { label: "192.168.0.X", prefix: "192.168.0." },
  { label: "192.168.X.X", prefix: "192.168." },
];

type CredForm = {
  siteId: string;
  type: string;
  serialNumber: string;
  ipAddress: string;
  pin: string;
  username: string;
  password: string;
  email: string;
  note: string;
  users: JablotronUser[];
};

const emptyForm: CredForm = {
  siteId: "",
  type: "",
  serialNumber: "",
  ipAddress: "",
  pin: "",
  username: "",
  password: "",
  email: "",
  note: "",
  users: [],
};

const NO_SITE = "__none__";

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function toPayload(f: CredForm) {
  const hasUsers = supportsUsers(f.type);
  return {
    siteId: f.siteId ? parseInt(f.siteId, 10) : null,
    type: f.type.trim() || null,
    serialNumber: f.serialNumber.trim() || null,
    ipAddress: f.ipAddress.trim(),
    pin: f.pin.trim() || null,
    username: f.username.trim() || null,
    password: f.password.trim() || null,
    email: f.email.trim() || null,
    note: f.note.trim() || null,
    users: hasUsers
      ? f.users
          .map((u) => ({
            id: u.id,
            name: u.name.trim(),
            pin: u.pin?.trim() ? u.pin.trim() : null,
            cards: u.cards.map((c) => c.trim()).filter(Boolean),
          }))
          .filter((u) => u.name || u.pin || u.cards.length > 0)
      : [],
  };
}

export default function PristupoveUdaje() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState<CredForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<CredForm>(emptyForm);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const scanOnResultRef = useRef<((text: string) => void) | null>(null);
  const scanToastRef = useRef<string>("Kód naskenován");

  const openScanner = (
    onResult: (text: string) => void,
    toastTitle = "Kód naskenován",
  ) => {
    scanOnResultRef.current = onResult;
    scanToastRef.current = toastTitle;
    setScannerOpen(true);
  };

  const { data: customers, isLoading: loadingCustomers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });

  const { data: sites } = useListCustomerSites(customerId ?? 0, {
    query: {
      queryKey: getListCustomerSitesQueryKey(customerId ?? 0),
      enabled: !!customerId,
    },
  });

  const { data: credentials, isLoading: loadingCreds } = useListDeviceCredentials(
    customerId ?? 0,
    {
      query: {
        queryKey: getListDeviceCredentialsQueryKey(customerId ?? 0),
        enabled: !!customerId,
      },
    },
  );

  const createCred = useCreateDeviceCredential();
  const updateCred = useUpdateDeviceCredential();
  const deleteCred = useDeleteDeviceCredential();

  const invalidate = () => {
    if (customerId)
      queryClient.invalidateQueries({
        queryKey: getListDeviceCredentialsQueryKey(customerId),
      });
  };

  const siteName = (siteId: number | null | undefined) =>
    sites?.find((s) => s.id === siteId)?.name;

  const grouped = useMemo(() => {
    const groups = new Map<string, DeviceCredential[]>();
    for (const c of credentials ?? []) {
      const key = c.siteId ? String(c.siteId) : NO_SITE;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return groups;
  }, [credentials]);

  const handleAdd = () => {
    if (!customerId) return;
    if (!newForm.ipAddress.trim()) {
      toast({ title: "Vyplňte IP adresu", variant: "destructive" });
      return;
    }
    createCred.mutate(
      { customerId, data: toPayload(newForm) },
      {
        onSuccess: () => {
          invalidate();
          setNewForm(emptyForm);
          setShowAdd(false);
          toast({ title: "Přístup přidán" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se přidat přístup", variant: "destructive" }),
      },
    );
  };

  const startEdit = (c: DeviceCredential) => {
    setEditingId(c.id);
    setEditForm({
      siteId: c.siteId ? String(c.siteId) : "",
      type: c.type || "",
      serialNumber: c.serialNumber || "",
      ipAddress: c.ipAddress || "",
      pin: c.pin || "",
      username: c.username || "",
      password: c.password || "",
      email: c.email || "",
      note: c.note || "",
      users: c.users ?? [],
    });
  };

  const handleUpdate = (id: number) => {
    if (!editForm.ipAddress.trim()) {
      toast({ title: "Vyplňte IP adresu", variant: "destructive" });
      return;
    }
    updateCred.mutate(
      { id, data: toPayload(editForm) },
      {
        onSuccess: () => {
          invalidate();
          setEditingId(null);
          toast({ title: "Přístup upraven" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se upravit přístup", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("Opravdu smazat tento přístup?")) return;
    deleteCred.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Přístup smazán" });
        },
        onError: () =>
          toast({ title: "Nepodařilo se smazat přístup", variant: "destructive" }),
      },
    );
  };

  const copy = (value: string | null | undefined, label: string) => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    toast({ title: `${label} zkopírováno` });
  };

  const renderForm = (
    form: CredForm,
    setForm: React.Dispatch<React.SetStateAction<CredForm>>,
  ) => {
    const isPresetType = (DEVICE_TYPES as readonly string[]).includes(form.type);
    const typeSelectValue = form.type === "" ? "" : isPresetType ? form.type : CUSTOM_TYPE;
    const hasUsers = supportsUsers(form.type);

    const setUsers = (updater: (users: JablotronUser[]) => JablotronUser[]) =>
      setForm((p) => ({ ...p, users: updater(p.users) }));

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block">Lokalita / stavba</Label>
            <select
              value={form.siteId}
              onChange={(e) => setForm((p) => ({ ...p, siteId: e.target.value }))}
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Bez lokality</option>
              {sites?.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="mb-1 block">Typ zařízení</Label>
            <select
              value={typeSelectValue}
              onChange={(e) => {
                const v = e.target.value;
                setForm((p) => ({
                  ...p,
                  type: v === "" ? "" : v === CUSTOM_TYPE ? "" : v,
                  users: supportsUsers(v) ? p.users : [],
                }));
              }}
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— Vyberte typ —</option>
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value={CUSTOM_TYPE}>Jiné (vlastní název)</option>
            </select>
            {typeSelectValue === CUSTOM_TYPE && (
              <Input
                value={form.type}
                onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
                placeholder="Vlastní typ zařízení"
                className="h-11 mt-2"
                autoFocus
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block">
              IP adresa <span className="text-destructive">*</span>
            </Label>
            <div className="flex gap-2">
              <select
                value=""
                onChange={(e) => {
                  const prefix = e.target.value;
                  if (prefix) setForm((p) => ({ ...p, ipAddress: prefix }));
                }}
                className="h-11 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
                aria-label="Předvolba IP"
              >
                <option value="">Předvolba</option>
                {IP_PREFIXES.map((p) => (
                  <option key={p.label} value={p.prefix}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Input
                value={form.ipAddress}
                onChange={(e) => setForm((p) => ({ ...p, ipAddress: e.target.value }))}
                placeholder="Např. 192.168.1.10"
                className="h-11"
                inputMode="decimal"
              />
            </div>
          </div>
          <div>
            <Label className="mb-1 block">PIN</Label>
            <Input
              value={form.pin}
              onChange={(e) => setForm((p) => ({ ...p, pin: e.target.value }))}
              placeholder="Volitelné"
              className="h-11"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block">Sériové číslo (SN)</Label>
            <div className="flex gap-2">
              <Input
                value={form.serialNumber}
                onChange={(e) => setForm((p) => ({ ...p, serialNumber: e.target.value }))}
                placeholder="SN"
                className="h-11"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                onClick={() =>
                  openScanner(
                    (text) => setForm((p) => ({ ...p, serialNumber: text })),
                    "Sériové číslo naskenováno",
                  )
                }
                aria-label="Naskenovat SN fotoaparátem"
                title="Naskenovat SN fotoaparátem"
              >
                <ScanLine className="h-5 w-5" />
              </Button>
            </div>
          </div>
          <div>
            <Label className="mb-1 block">E-mail</Label>
            <Input
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              placeholder="email@firma.cz"
              type="email"
              className="h-11"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block">Uživatelské jméno</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
              placeholder="admin"
              className="h-11"
              autoComplete="off"
            />
          </div>
          <div>
            <Label className="mb-1 block">Heslo</Label>
            <Input
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              placeholder="heslo"
              className="h-11"
              autoComplete="off"
            />
          </div>
        </div>

        {hasUsers && (
          <div className="rounded-md border border-input bg-background/50 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 m-0">
                <Users className="h-4 w-4 text-primary" /> Uživatelé ({form.type})
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() =>
                  setUsers((us) => [
                    ...us,
                    { id: newId(), name: "", pin: "", cards: [] },
                  ])
                }
              >
                <Plus className="h-4 w-4 mr-1" /> Přidat uživatele
              </Button>
            </div>
            {form.users.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Zatím žádní uživatelé. Přidejte uživatele s PINem a kartami.
              </p>
            ) : (
              form.users.map((u) => (
                <div key={u.id} className="rounded-md border border-input p-3 space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={u.name}
                      onChange={(e) =>
                        setUsers((us) =>
                          us.map((x) =>
                            x.id === u.id ? { ...x, name: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="Jméno uživatele"
                      className="h-10"
                    />
                    <Input
                      value={u.pin ?? ""}
                      onChange={(e) =>
                        setUsers((us) =>
                          us.map((x) =>
                            x.id === u.id ? { ...x, pin: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="PIN"
                      className="h-10 w-28"
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0 text-destructive hover:bg-destructive/10"
                      onClick={() => setUsers((us) => us.filter((x) => x.id !== u.id))}
                      aria-label="Smazat uživatele"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2 pl-1">
                    <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <CreditCard className="h-3.5 w-3.5" /> Karty
                    </div>
                    {u.cards.map((card, ci) => (
                      <div key={ci} className="flex gap-2">
                        <Input
                          value={card}
                          onChange={(e) =>
                            setUsers((us) =>
                              us.map((x) =>
                                x.id === u.id
                                  ? {
                                      ...x,
                                      cards: x.cards.map((c, i) =>
                                        i === ci ? e.target.value : c,
                                      ),
                                    }
                                  : x,
                              ),
                            )
                          }
                          placeholder="Číslo karty"
                          className="h-9"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9 shrink-0"
                          onClick={() =>
                            openScanner(
                              (text) =>
                                setUsers((us) =>
                                  us.map((x) =>
                                    x.id === u.id
                                      ? {
                                          ...x,
                                          cards: x.cards.map((c, i) =>
                                            i === ci ? text : c,
                                          ),
                                        }
                                      : x,
                                  ),
                                ),
                              "Číslo karty naskenováno",
                            )
                          }
                          aria-label="Naskenovat číslo karty fotoaparátem"
                          title="Naskenovat číslo karty fotoaparátem"
                        >
                          <ScanLine className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10"
                          onClick={() =>
                            setUsers((us) =>
                              us.map((x) =>
                                x.id === u.id
                                  ? { ...x, cards: x.cards.filter((_, i) => i !== ci) }
                                  : x,
                              ),
                            )
                          }
                          aria-label="Smazat kartu"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-primary"
                      onClick={() =>
                        setUsers((us) =>
                          us.map((x) =>
                            x.id === u.id ? { ...x, cards: [...x.cards, ""] } : x,
                          ),
                        )
                      }
                    >
                      <Plus className="h-4 w-4 mr-1" /> Přidat kartu
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <div>
          <Label className="mb-1 block">Poznámka</Label>
          <Textarea
            value={form.note}
            onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
            rows={2}
            placeholder="Port, další detaily…"
          />
        </div>
      </div>
    );
  };

  const renderField = (
    icon: React.ReactNode,
    label: string,
    value: string | null | undefined,
  ) => {
    if (!value) return null;
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="text-muted-foreground">{label}:</span>
        <span className="font-medium break-all">{value}</span>
        <button
          type="button"
          onClick={() => copy(value, label)}
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
          aria-label={`Kopírovat ${label}`}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const renderCredCard = (c: DeviceCredential) => {
    if (editingId === c.id) {
      return (
        <Card key={c.id} className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 space-y-3">
            {renderForm(editForm, setEditForm)}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => handleUpdate(c.id)}
                disabled={updateCred.isPending}
                className="h-9"
              >
                <Save className="h-4 w-4 mr-1" /> Uložit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingId(null)}
                className="h-9"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }

    const isRevealed = !!revealed[c.id];
    return (
      <Card key={c.id}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="bg-rose-100 dark:bg-rose-950/40 p-2 rounded-lg text-rose-600 shrink-0">
              <Server className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="font-semibold">{c.type || "Zařízení"}</p>
              {renderField(<Network className="h-3.5 w-3.5" />, "IP adresa", c.ipAddress)}
              {renderField(<Server className="h-3.5 w-3.5" />, "SN", c.serialNumber)}
              {c.pin && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground shrink-0">
                    <Hash className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-muted-foreground">PIN:</span>
                  <span className="font-medium font-mono break-all">
                    {isRevealed ? c.pin : "••••"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRevealed((p) => ({ ...p, [c.id]: !p[c.id] }))}
                    className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
                    aria-label={isRevealed ? "Skrýt PIN" : "Zobrazit PIN"}
                  >
                    {isRevealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => copy(c.pin, "PIN")}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Kopírovat PIN"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {renderField(<UserIcon className="h-3.5 w-3.5" />, "Uživatel", c.username)}
              {c.password && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground shrink-0">
                    <KeyRound className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-muted-foreground">Heslo:</span>
                  <span className="font-medium font-mono break-all">
                    {isRevealed ? c.password : "••••••••"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setRevealed((p) => ({ ...p, [c.id]: !p[c.id] }))
                    }
                    className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
                    aria-label={isRevealed ? "Skrýt heslo" : "Zobrazit heslo"}
                  >
                    {isRevealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => copy(c.password, "Heslo")}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Kopírovat heslo"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {renderField(<Mail className="h-3.5 w-3.5" />, "E-mail", c.email)}
              {c.users && c.users.length > 0 && (
                <div className="text-sm space-y-1 pt-1">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    <span>Uživatelé ({c.users.length}):</span>
                  </div>
                  <ul className="pl-5 space-y-0.5">
                    {c.users.map((u) => (
                      <li key={u.id} className="break-words">
                        <span className="font-medium">{u.name || "Bez jména"}</span>
                        {u.pin && (
                          <span className="text-muted-foreground">
                            {" "}
                            · PIN {isRevealed ? u.pin : "••••"}
                          </span>
                        )}
                        {u.cards.length > 0 && (
                          <span className="text-muted-foreground">
                            {" "}
                            · karty: {u.cards.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {c.note && (
                <div className="flex items-start gap-2 text-sm">
                  <span className="text-muted-foreground shrink-0 mt-0.5">
                    <FileText className="h-3.5 w-3.5" />
                  </span>
                  <span className="whitespace-pre-line break-words">{c.note}</span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(c)}>
                <Edit3 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:bg-destructive/10"
                onClick={() => handleDelete(c.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const orderedGroupKeys = useMemo(() => {
    const keys = Array.from(grouped.keys());
    keys.sort((a, b) => {
      if (a === NO_SITE) return 1;
      if (b === NO_SITE) return -1;
      return (siteName(parseInt(a, 10)) || "").localeCompare(
        siteName(parseInt(b, 10)) || "",
      );
    });
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, sites]);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-2 mb-6">
        <div className="bg-rose-100 dark:bg-rose-950/40 p-2 rounded-lg text-rose-600">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Přístupové údaje</h1>
          <p className="text-sm text-muted-foreground">
            Přihlašovací údaje k zařízením podle zákazníka a lokality.
          </p>
        </div>
      </div>

      <div className="mb-6">
        <Label className="mb-1 block">Zákazník</Label>
        {loadingCustomers ? (
          <Skeleton className="h-11 w-full" />
        ) : (
          <select
            value={customerId ?? ""}
            onChange={(e) => {
              setCustomerId(e.target.value ? parseInt(e.target.value, 10) : null);
              setShowAdd(false);
              setEditingId(null);
            }}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— Vyberte zákazníka —</option>
            {customers?.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.companyName}
              </option>
            ))}
          </select>
        )}
      </div>

      {!customerId ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
          <Building2 className="h-12 w-12 mb-4 opacity-20" />
          <p>Vyberte zákazníka pro zobrazení přístupových údajů.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-base font-bold">Uložené přístupy</h2>
            <div className="flex items-center gap-2">
              {credentials && credentials.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9"
                  onClick={() => setLocation(`/pristupove-udaje/export/${customerId}`)}
                >
                  <FileDown className="h-4 w-4 mr-1" /> Export pro zákazníka
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                onClick={() => {
                  setShowAdd(true);
                  setNewForm(emptyForm);
                }}
              >
                <Plus className="h-4 w-4 mr-1" /> Přidat
              </Button>
            </div>
          </div>

          {showAdd && (
            <Card className="mb-4 border-primary/30 bg-primary/5">
              <CardContent className="p-4 space-y-3">
                {renderForm(newForm, setNewForm)}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleAdd}
                    disabled={createCred.isPending}
                    className="h-9"
                  >
                    <Save className="h-4 w-4 mr-1" /> Uložit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowAdd(false);
                      setNewForm(emptyForm);
                    }}
                    className="h-9"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {loadingCreds ? (
            <Skeleton className="h-24 w-full" />
          ) : credentials && credentials.length > 0 ? (
            <div className="space-y-5">
              {orderedGroupKeys.map((key) => {
                const list = grouped.get(key) ?? [];
                const label =
                  key === NO_SITE
                    ? "Bez lokality"
                    : siteName(parseInt(key, 10)) || "Neznámá lokalita";
                return (
                  <div key={key} className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                      <MapPin className="h-4 w-4 text-rose-500" />
                      {label}
                    </div>
                    <div className="space-y-2">{list.map(renderCredCard)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-center">
              <KeyRound className="h-10 w-10 mb-3 opacity-20" />
              <p>Žádné uložené přístupy. Přidejte první pomocí tlačítka „Přidat".</p>
            </div>
          )}
        </>
      )}

      <BarcodeScanner
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onResult={(text) => {
          scanOnResultRef.current?.(text);
          setScannerOpen(false);
          toast({ title: scanToastRef.current });
        }}
      />
    </div>
  );
}
