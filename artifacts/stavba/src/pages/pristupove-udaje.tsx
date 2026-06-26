import { useCallback, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useLocation } from "wouter";
import {
  useListCustomers,
  useListCustomerSites,
  useListDeviceCredentials,
  useCreateDeviceCredential,
  useUpdateDeviceCredential,
  useDeleteDeviceCredential,
  useAuditCredentialAccess,
  getListCustomersQueryKey,
  getListCustomerSitesQueryKey,
  getListDeviceCredentialsQueryKey,
  type DeviceCredential,
  type JablotronUser,
  type NetworkDevice,
  type NetworkPort,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Autocomplete } from "@/components/autocomplete";
import {
  KeyRound, Plus, Save, X, Edit3, Trash2, Eye, EyeOff, Copy,
  Building2, MapPin, Server, User as UserIcon, Mail, FileText,
  Network, Hash, ScanLine, Users, CreditCard, FileDown, ShieldAlert,
  ExternalLink, AlertTriangle, Router, GitBranch, ChevronDown, ChevronRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BarcodeScanner } from "@/components/barcode-scanner";
import { NetworkTopologyDiagram } from "@/components/network-topology-diagram";

const DEVICE_TYPES = [
  "Lokální síť",
  "NVR",
  "Kamera",
  "Router",
  "Switch",
  "Access system",
  "Jablotron",
  "Loxone",
] as const;

const CUSTOM_TYPE = "__custom__";
const NETWORK_TYPE = "Lokální síť";

const USER_DEVICE_TYPES = ["Jablotron", "Access system", "Loxone"];
const supportsUsers = (type: string) =>
  USER_DEVICE_TYPES.includes(type.trim());
const isNetworkType = (type: string) => type.trim() === NETWORK_TYPE;

const NETWORK_DEVICE_TYPES = [
  "Router",
  "Switch",
  "Access Point",
  "Firewall",
  "NAS",
  "Server",
  "PC",
  "Tiskárna",
  "IP kamera",
  "NVR",
  "VoIP telefon",
  "Jiné",
] as const;

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
  networkTopology: NetworkDevice[];
};

const emptyNetworkDevice = (): NetworkDevice => ({
  id: newId(),
  deviceType: "Router",
  name: "",
  ipAddress: "",
  quantity: 1,
  note: "",
  ports: [],
});

const emptyNetworkPort = (): NetworkPort => ({
  id: newId(),
  portNumber: "",
  name: "",
  connectedDevice: "",
});

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
  networkTopology: [],
};

const NO_SITE = "__none__";

function NetworkDeviceRow({
  device,
  index,
  onChange,
  onRemove,
}: {
  device: NetworkDevice;
  index: number;
  onChange: (d: NetworkDevice) => void;
  onRemove: () => void;
}) {
  const [showPorts, setShowPorts] = useState(false);
  const set = (patch: Partial<NetworkDevice>) => onChange({ ...device, ...patch });

  return (
    <div className="rounded-md border border-input bg-background p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground w-5 shrink-0">
          #{index + 1}
        </span>
        <select
          value={device.deviceType}
          onChange={(e) => set({ deviceType: e.target.value })}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm w-36 shrink-0"
        >
          {NETWORK_DEVICE_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <Input
          value={device.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Název (např. Router hlavní)"
          className="h-9 flex-1 min-w-0"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10"
          onClick={onRemove}
          aria-label="Smazat zařízení"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 pl-7">
        <Input
          value={device.ipAddress}
          onChange={(e) => set({ ipAddress: e.target.value })}
          placeholder="IP adresa"
          className="h-9"
          inputMode="decimal"
        />
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">Počet:</Label>
          <Input
            type="number"
            min={1}
            value={device.quantity}
            onChange={(e) =>
              set({ quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })
            }
            className="h-9 w-20"
          />
        </div>
      </div>

      <div className="pl-7">
        <Input
          value={device.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Poznámka (volitelné)"
          className="h-9"
        />
      </div>

      <div className="pl-7">
        <button
          type="button"
          onClick={() => setShowPorts((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {showPorts ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Porty / rozhraní ({device.ports.length})
        </button>

        {showPorts && (
          <div className="mt-2 space-y-2">
            {device.ports.map((port) => (
              <div key={port.id} className="flex gap-2 items-center">
                <Input
                  value={port.portNumber}
                  onChange={(e) =>
                    set({
                      ports: device.ports.map((p) =>
                        p.id === port.id ? { ...p, portNumber: e.target.value } : p,
                      ),
                    })
                  }
                  placeholder="Port"
                  className="h-8 w-16 shrink-0"
                />
                <Input
                  value={port.name}
                  onChange={(e) =>
                    set({
                      ports: device.ports.map((p) =>
                        p.id === port.id ? { ...p, name: e.target.value } : p,
                      ),
                    })
                  }
                  placeholder="Název"
                  className="h-8 flex-1 min-w-0"
                />
                <Input
                  value={port.connectedDevice}
                  onChange={(e) =>
                    set({
                      ports: device.ports.map((p) =>
                        p.id === port.id
                          ? { ...p, connectedDevice: e.target.value }
                          : p,
                      ),
                    })
                  }
                  placeholder="Připojené zařízení"
                  className="h-8 flex-1 min-w-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    set({ ports: device.ports.filter((p) => p.id !== port.id) })
                  }
                  aria-label="Smazat port"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-primary"
              onClick={() =>
                set({ ports: [...device.ports, emptyNetworkPort()] })
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Přidat port
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function toPayload(f: CredForm) {
  const hasUsers = supportsUsers(f.type);
  const hasNetwork = isNetworkType(f.type);
  return {
    siteId: f.siteId ? parseInt(f.siteId, 10) : null,
    type: f.type.trim() || null,
    serialNumber: f.serialNumber.trim() || null,
    ipAddress: f.ipAddress.trim() || null,
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
    networkTopology: hasNetwork ? f.networkTopology : [],
  };
}

function NetworkTopologyView({ topology }: { topology: NetworkDevice[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"diagram" | "table">("diagram");
  const toggle = (id: string) =>
    setExpanded((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground font-medium">
          <Router className="h-3.5 w-3.5 text-blue-500" />
          <span>Přehled sítě ({topology.length} zařízení)</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-blue-100 dark:border-blue-900 p-0.5">
          <button
            type="button"
            onClick={() => setView("diagram")}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              view === "diagram"
                ? "bg-blue-500 text-white"
                : "text-muted-foreground hover:bg-blue-50 dark:hover:bg-blue-950/40"
            }`}
          >
            <GitBranch className="h-3 w-3" />
            Diagram
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              view === "table"
                ? "bg-blue-500 text-white"
                : "text-muted-foreground hover:bg-blue-50 dark:hover:bg-blue-950/40"
            }`}
          >
            Tabulka
          </button>
        </div>
      </div>
      {view === "diagram" && (
        <div className="rounded-md border border-blue-100 dark:border-blue-900 bg-slate-50/50 dark:bg-slate-900/20 p-2">
          <NetworkTopologyDiagram topology={topology} />
        </div>
      )}
      {view === "table" && (
      <div className="rounded-md border border-blue-100 dark:border-blue-900 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-blue-50 dark:bg-blue-950/30 text-muted-foreground">
              <th className="text-left px-2 py-1.5 font-medium">Typ</th>
              <th className="text-left px-2 py-1.5 font-medium">Název</th>
              <th className="text-left px-2 py-1.5 font-medium">IP adresa</th>
              <th className="text-right px-2 py-1.5 font-medium">Počet</th>
              <th className="w-8 px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {topology.map((dev) => (
              <>
                <tr
                  key={dev.id}
                  className={`border-t border-blue-100 dark:border-blue-900 ${dev.ports.length > 0 ? "cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-950/20" : ""}`}
                  onClick={() => dev.ports.length > 0 && toggle(dev.id)}
                >
                  <td className="px-2 py-1.5 text-muted-foreground">{dev.deviceType}</td>
                  <td className="px-2 py-1.5 font-medium">{dev.name || "—"}</td>
                  <td className="px-2 py-1.5 font-mono">{dev.ipAddress || "—"}</td>
                  <td className="px-2 py-1.5 text-right">{dev.quantity}</td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">
                    {dev.ports.length > 0 && (
                      expanded[dev.id] ? (
                        <ChevronDown className="h-3.5 w-3.5 inline" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 inline" />
                      )
                    )}
                  </td>
                </tr>
                {expanded[dev.id] && dev.ports.length > 0 && (
                  <tr key={`${dev.id}-ports`} className="border-t border-blue-100 dark:border-blue-900 bg-slate-50/80 dark:bg-slate-900/30">
                    <td colSpan={5} className="px-4 pb-2 pt-1">
                      <div className="text-xs text-muted-foreground mb-1 font-medium">Porty / rozhraní:</div>
                      <table className="w-full">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="text-left pr-3 py-0.5 font-medium w-16">Port</th>
                            <th className="text-left pr-3 py-0.5 font-medium">Název</th>
                            <th className="text-left py-0.5 font-medium">Připojené zařízení</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dev.ports.map((port) => (
                            <tr key={port.id}>
                              <td className="pr-3 py-0.5 font-mono">{port.portNumber || "—"}</td>
                              <td className="pr-3 py-0.5">{port.name || "—"}</td>
                              <td className="py-0.5 text-muted-foreground">{port.connectedDevice || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {dev.note && (
                        <p className="text-muted-foreground mt-1">
                          <span className="font-medium">Pozn.:</span> {dev.note}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
                {!expanded[dev.id] && dev.note && (
                  <tr key={`${dev.id}-note`} className="border-t border-blue-100 dark:border-blue-900">
                    <td colSpan={5} className="px-2 pb-1.5 text-muted-foreground italic">
                      {dev.note}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

export default function PristupoveUdaje() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { openConfirm, dialogProps } = useConfirmDialog();

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState<CredForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<CredForm>(emptyForm);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const scanOnResultRef = useRef<((text: string) => void) | null>(null);
  const scanToastRef = useRef<string>("Kód naskenován");

  const auditAccess = useAuditCredentialAccess();

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

  const customerOptions = useMemo(() => {
    const list = customers ?? [];
    const nameCounts = new Map<string, number>();
    for (const c of list) {
      const key = c.companyName.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    return list.map((c) => {
      const isDup = (nameCounts.get(c.companyName.trim().toLowerCase()) ?? 0) > 1;
      const label = isDup
        ? `${c.companyName}${c.address ? ` — ${c.address}` : ` (#${c.id})`}`
        : c.companyName;
      return { id: c.id, label };
    });
  }, [customers]);

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
    if (customerId) invalidateData(queryClient, "customers");
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
    if (!isNetworkType(newForm.type) && !newForm.ipAddress.trim()) {
      toast({ title: "Vyplňte IP adresu", variant: "destructive" });
      return;
    }
    if (!newForm.siteId) {
      toast({
        title: "Přístup nemá lokalitu",
        description: "Doporučujeme přiřadit přístup ke konkrétní stavbě nebo pobočce.",
        variant: "default",
      });
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
      networkTopology: (c.networkTopology as NetworkDevice[]) ?? [],
    });
  };

  const handleUpdate = (id: number) => {
    if (!isNetworkType(editForm.type) && !editForm.ipAddress.trim()) {
      toast({ title: "Vyplňte IP adresu", variant: "destructive" });
      return;
    }
    if (!editForm.siteId) {
      toast({
        title: "Přístup nemá lokalitu",
        description: "Doporučujeme přiřadit přístup ke konkrétní stavbě nebo pobočce.",
        variant: "default",
      });
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
    openConfirm("Opravdu smazat tento přístup?", () => {
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
    });
  };

  const logAccess = useCallback(
    (credId: number, action: "view" | "copy", field: "pin" | "password" | "card" | "username") => {
      auditAccess.mutate({ id: credId, data: { action, field } });
    },
    [auditAccess],
  );

  const copy = (credId: number, value: string | null | undefined, label: string, field: "pin" | "password" | "card" | "username") => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    logAccess(credId, "copy", field);
    toast({ title: `${label} zkopírováno` });
  };

  const handleReveal = (credId: number, field: "pin" | "password") => {
    const wasRevealed = !!revealed[credId];
    setRevealed((p) => ({ ...p, [credId]: !p[credId] }));
    if (!wasRevealed) {
      logAccess(credId, "view", field);
    }
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
            {!form.siteId && sites && sites.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Doporučujeme přiřadit lokalitu
              </p>
            )}
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
              IP adresa{isNetworkType(form.type) ? (
                <span className="text-muted-foreground font-normal"> (gateway / nepovinné)</span>
              ) : (
                <span className="text-destructive"> *</span>
              )}
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
                <option value="Nemá">Nemá</option>
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

        {isNetworkType(form.type) && (
          <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2 m-0 text-blue-700 dark:text-blue-300">
                <GitBranch className="h-4 w-4" /> Topologie sítě
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    networkTopology: [...p.networkTopology, emptyNetworkDevice()],
                  }))
                }
              >
                <Plus className="h-4 w-4 mr-1" /> Přidat zařízení
              </Button>
            </div>
            {form.networkTopology.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Žádná zařízení. Přidejte routery, switche a další prvky sítě.
              </p>
            ) : (
              form.networkTopology.map((dev, di) => (
                <NetworkDeviceRow
                  key={dev.id}
                  device={dev}
                  index={di}
                  onChange={(updated) =>
                    setForm((p) => ({
                      ...p,
                      networkTopology: p.networkTopology.map((d) =>
                        d.id === dev.id ? updated : d,
                      ),
                    }))
                  }
                  onRemove={() =>
                    setForm((p) => ({
                      ...p,
                      networkTopology: p.networkTopology.filter(
                        (d) => d.id !== dev.id,
                      ),
                    }))
                  }
                />
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
    credId: number,
    field: "pin" | "password" | "card" | "username",
  ) => {
    if (!value) return null;
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="text-muted-foreground">{label}:</span>
        <span className="font-medium break-all">{value}</span>
        <button
          type="button"
          onClick={() => copy(credId, value, label, field)}
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
              {renderField(<Network className="h-3.5 w-3.5" />, "IP adresa", c.ipAddress, c.id, "username")}
              {renderField(<Server className="h-3.5 w-3.5" />, "SN", c.serialNumber, c.id, "username")}
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
                    onClick={() => handleReveal(c.id, "pin")}
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
                    onClick={() => copy(c.id, c.pin, "PIN", "pin")}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Kopírovat PIN"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {renderField(<UserIcon className="h-3.5 w-3.5" />, "Uživatel", c.username, c.id, "username")}
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
                    onClick={() => handleReveal(c.id, "password")}
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
                    onClick={() => copy(c.id, c.password, "Heslo", "password")}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Kopírovat heslo"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {renderField(<Mail className="h-3.5 w-3.5" />, "E-mail", c.email, c.id, "username")}
              {c.users && c.users.length > 0 && (
                <div className="text-sm space-y-2 pt-1">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    <span>Uživatelé ({c.users.length}):</span>
                  </div>
                  <div className="pl-1 space-y-2">
                    {c.users.map((u) => (
                      <div key={u.id} className="space-y-1">
                        <p className="font-medium">{u.name || "Bez jména"}</p>
                        {u.pin && (
                          <div className="flex items-center gap-2 ml-2">
                            <Hash className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="text-muted-foreground text-xs">PIN:</span>
                            <span className="font-mono text-xs">
                              {isRevealed ? u.pin : "••••"}
                            </span>
                            <button
                              type="button"
                              onClick={() => copy(c.id, u.pin ?? null, "PIN uživatele", "pin")}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label="Kopírovat PIN uživatele"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        {u.cards.length > 0 && (
                          <div className="ml-2 space-y-0.5">
                            {u.cards.map((card, ci) => (
                              <div key={ci} className="flex items-center gap-2">
                                <CreditCard className="h-3 w-3 text-muted-foreground shrink-0" />
                                <span className="text-xs font-mono">{card}</span>
                                <button
                                  type="button"
                                  onClick={() => copy(c.id, card, "Číslo karty", "card")}
                                  className="text-muted-foreground hover:text-foreground"
                                  aria-label="Kopírovat číslo karty"
                                >
                                  <Copy className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {c.networkTopology && (c.networkTopology as NetworkDevice[]).length > 0 && (
                <NetworkTopologyView topology={c.networkTopology as NetworkDevice[]} />
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

  const selectedCustomer = customerId
    ? customers?.find((c) => c.id === customerId)
    : null;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-2 mb-4">
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

      {/* Security notice */}
      <div className="flex items-start gap-2 p-3 mb-5 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-700 dark:text-blue-300">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
        <span>Zobrazení a kopírování přístupů se zapisuje do záznamu změn.</span>
      </div>

      <div className="mb-6">
        <Label className="mb-1 block">Zákazník</Label>
        {loadingCustomers ? (
          <Skeleton className="h-11 w-full" />
        ) : (
          <Autocomplete
            value={customerQuery}
            onValueChange={(v) => {
              setCustomerQuery(v);
              const match = customerOptions.find(
                (o) => o.label.trim().toLowerCase() === v.trim().toLowerCase(),
              );
              setCustomerId(match ? match.id : null);
              setShowAdd(false);
              setEditingId(null);
            }}
            suggestions={customerOptions.map((o) => o.label)}
            maxItems={12}
            placeholder="Začněte psát název zákazníka…"
            className="h-11"
          />
        )}
      </div>

      {!customerId ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
          <Building2 className="h-12 w-12 mb-4 opacity-20" />
          <p className="mb-4">Vyberte zákazníka pro zobrazení přístupových údajů.</p>
          <div className="flex gap-2 flex-wrap justify-center">
            <Button variant="outline" onClick={() => setLocation("/customers")}>
              <Building2 className="h-4 w-4 mr-2" /> Přejít na zákazníky
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Customer quick link */}
          {selectedCustomer && (
            <button
              type="button"
              onClick={() => setLocation(`/customers/${customerId}`)}
              className="flex items-center gap-2 text-sm text-primary hover:underline mb-4"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Detail zákazníka: {selectedCustomer.companyName}
            </button>
          )}

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

      <ConfirmDialog {...dialogProps} />
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
