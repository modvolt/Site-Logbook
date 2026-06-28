import { useState, useMemo, useRef, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import QRCode from "qrcode";
import {
  useListPpeItems,
  useCreatePpeItem,
  useUpdatePpeItem,
  useArchivePpeItem,
  useListPpeAssignments,
  useCreatePpeAssignment,
  useUpdatePpeAssignment,
  useRequestPpeConfirm,
  useSignPpeHandover,
  useListPeople,
  getListPpeItemsQueryKey,
  getListPpeAssignmentsQueryKey,
  getListPeopleQueryKey,
  PpeItemInputCategory,
  PpeAssignmentUpdateStatus,
  type PpeItem,
  type PpeAssignment,
  type PpeItemInput,
  type PpeAssignmentUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft, Plus, ShieldCheck, AlertCircle, Clock, Archive, CheckCircle2, ChevronRight, User, Package, Download, QrCode, Link2, Copy, X, Check, PenLine, FileText, Image, History, Eye
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  PPE_CATEGORY_LABELS,
  PPE_STATUS_LABELS,
  PPE_STATUS_COLORS,
  isPpeOverdue,
  computeDefaultDates,
  formatPpeDate,
} from "@/lib/ppe-format";

const PPE_CATEGORIES = ["hlava", "ruky", "telo", "nohy", "oci", "sluch", "dychaci", "ostatni"] as const;
const PPE_STATUSES = ["issued", "returned", "damaged", "lost", "disposed"] as const;

type Tab = "vydeje" | "katalog";

function ShareSignDialog({
  assignment,
  onClose,
}: {
  assignment: PpeAssignment;
  onClose: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  function generateToken() {
    setLoading(true);
    setError(null);
    setRevoked(false);
    fetch(`/api/ppe/assignments/${assignment.id}/sign-token`, { method: "POST" })
      .then((r) => r.json())
      .then(async (data: { error?: string; signUrl?: string }) => {
        if (data.error) { setError(data.error); return; }
        const fullUrl = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}${data.signUrl}`;
        setSignUrl(fullUrl);
        const qr = await QRCode.toDataURL(fullUrl, { width: 240, margin: 2 });
        setQrDataUrl(qr);
      })
      .catch(() => setError("Nepodařilo se vygenerovat odkaz"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    generateToken();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  function copyLink() {
    if (!signUrl) return;
    navigator.clipboard.writeText(signUrl).then(() => {
      toast({ title: "Odkaz zkopírován" });
    });
  }

  function revokeToken() {
    setRevoking(true);
    fetch(`/api/ppe/assignments/${assignment.id}/sign-token`, { method: "DELETE" })
      .then((r) => {
        if (r.ok || r.status === 204) {
          setSignUrl(null);
          setQrDataUrl(null);
          setRevoked(true);
          toast({ title: "Odkaz byl zrušen" });
          invalidateData(qc, "ppe");
          return;
        }
        return r.json().then((data: { error?: string }) => {
          setError(data.error ?? "Nepodařilo se zrušit odkaz");
        });
      })
      .catch(() => setError("Nepodařilo se zrušit odkaz"))
      .finally(() => setRevoking(false));
  }

  return (
    <Card className="mb-6 border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold flex items-center gap-2">
            <QrCode className="h-4 w-4 text-blue-600" />
            Podpis zaměstnance
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Pošlete zaměstnanci <strong>{assignment.personNameSnapshot}</strong> odkaz nebo nechte naskenovat QR kód, aby mohl potvrdit převzetí <strong>{assignment.ppeNameSnapshot}</strong>.
        </p>
        {loading && <div className="text-sm text-muted-foreground py-4 text-center">Generuji odkaz…</div>}
        {error && <div className="text-sm text-destructive">{error}</div>}
        {revoked && !loading && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Odkaz byl zrušen a již není platný.</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={generateToken}>
              <QrCode className="h-3.5 w-3.5" /> Vygenerovat nový odkaz
            </Button>
          </div>
        )}
        {!loading && !error && !revoked && (
          <div className="flex flex-col sm:flex-row items-center gap-4">
            {qrDataUrl && (
              <img src={qrDataUrl} alt="QR kód pro podpis" className="w-32 h-32 rounded-lg border bg-white p-1 shrink-0" />
            )}
            <div className="flex-1 min-w-0 space-y-2 w-full">
              <p className="text-xs text-muted-foreground break-all font-mono bg-white border rounded px-2 py-1.5 select-all">
                {signUrl}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={copyLink}>
                  <Copy className="h-3.5 w-3.5" /> Zkopírovat odkaz
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={revokeToken}
                  disabled={revoking}
                >
                  <X className="h-3.5 w-3.5" /> Zrušit odkaz
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PpeStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PPE_STATUS_COLORS[status] ?? ""}`}>
      {PPE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

function OverdueBadge({ assignment }: { assignment: PpeAssignment }) {
  if (!isPpeOverdue(assignment)) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 text-destructive px-2 py-0.5 text-[11px] font-medium">
      <AlertCircle className="h-3 w-3" /> Po termínu
    </span>
  );
}

function ItemForm({
  initial,
  onSave,
  onCancel,
  isPending,
}: {
  initial?: Partial<PpeItem>;
  onSave: (data: PpeItemInput) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<PpeItemInputCategory>(
    (initial?.category as PpeItemInputCategory) ?? PpeItemInputCategory.ostatni,
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [replMonths, setReplMonths] = useState(initial?.defaultReplacementMonths?.toString() ?? "");
  const [inspMonths, setInspMonths] = useState(initial?.defaultInspectionMonths?.toString() ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      category,
      description: description.trim() || null,
      defaultReplacementMonths: replMonths ? parseInt(replMonths) : null,
      defaultInspectionMonths: inspMonths ? parseInt(inspMonths) : null,
      notes: notes.trim() || null,
      active: initial?.active !== false,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Název pomůcky *"
        className="h-11 bg-background"
        autoFocus
      />
      <Select value={category} onValueChange={(v) => setCategory(v as PpeItemInputCategory)}>
        <SelectTrigger className="h-11 bg-background">
          <SelectValue placeholder="Kategorie" />
        </SelectTrigger>
        <SelectContent>
          {PPE_CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>{PPE_CATEGORY_LABELS[c]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Popis (volitelný)"
        className="h-11 bg-background"
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Výměna za (měsíců)</label>
          <Input
            type="number"
            min="1"
            value={replMonths}
            onChange={(e) => setReplMonths(e.target.value)}
            placeholder="—"
            className="h-11 bg-background"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Kontrola za (měsíců)</label>
          <Input
            type="number"
            min="1"
            value={inspMonths}
            onChange={(e) => setInspMonths(e.target.value)}
            placeholder="—"
            className="h-11 bg-background"
          />
        </div>
      </div>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Poznámka (volitelná)"
        className="bg-background resize-none"
        rows={2}
      />
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>Zrušit</Button>
        <Button type="submit" disabled={!name.trim() || isPending}>Uložit</Button>
      </div>
    </form>
  );
}

function AssignmentForm({
  items,
  people,
  prefillPersonId,
  onSave,
  onCancel,
  isPending,
}: {
  items: PpeItem[];
  people: { id: number; name: string }[];
  prefillPersonId?: number | null;
  onSave: (data: {
    ppeItemId: number; personId: number; quantity: number; size: string | null;
    serialNumber: string | null; issuedAt: string; replaceBy: string | null; nextInspectionAt: string | null; notes: string | null;
  }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [ppeItemId, setPpeItemId] = useState("");
  const [personId, setPersonId] = useState(prefillPersonId ? String(prefillPersonId) : "");
  const [quantity, setQuantity] = useState("1");
  const [size, setSize] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(todayStr);
  const [replaceBy, setReplaceBy] = useState("");
  const [nextInspectionAt, setNextInspectionAt] = useState("");
  const [notes, setNotes] = useState("");

  const selectedItem = items.find((i) => i.id === parseInt(ppeItemId));

  const handleItemChange = (val: string) => {
    setPpeItemId(val);
    const item = items.find((i) => i.id === parseInt(val));
    if (item && issuedAt) {
      const defaults = computeDefaultDates(issuedAt, item);
      if (defaults.replaceBy && !replaceBy) setReplaceBy(defaults.replaceBy);
      if (defaults.nextInspectionAt && !nextInspectionAt) setNextInspectionAt(defaults.nextInspectionAt);
    }
  };

  const handleIssuedAtChange = (val: string) => {
    setIssuedAt(val);
    if (selectedItem && val) {
      const defaults = computeDefaultDates(val, selectedItem);
      if (defaults.replaceBy) setReplaceBy(defaults.replaceBy);
      if (defaults.nextInspectionAt) setNextInspectionAt(defaults.nextInspectionAt);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ppeItemId || !personId || !issuedAt) return;
    onSave({
      ppeItemId: parseInt(ppeItemId),
      personId: parseInt(personId),
      quantity: parseInt(quantity) || 1,
      size: size.trim() || null,
      serialNumber: serialNumber.trim() || null,
      issuedAt,
      replaceBy: replaceBy || null,
      nextInspectionAt: nextInspectionAt || null,
      notes: notes.trim() || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Select value={personId} onValueChange={setPersonId}>
        <SelectTrigger className="h-11 bg-background">
          <SelectValue placeholder="Zaměstnanec *" />
        </SelectTrigger>
        <SelectContent>
          {people.map((p) => (
            <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={ppeItemId} onValueChange={handleItemChange}>
        <SelectTrigger className="h-11 bg-background">
          <SelectValue placeholder="Pomůcka *" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id.toString()}>
              {i.name} <span className="text-muted-foreground text-xs">({PPE_CATEGORY_LABELS[i.category]})</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Počet *</label>
          <Input
            type="number"
            min="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="h-11 bg-background"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Velikost</label>
          <Input value={size} onChange={(e) => setSize(e.target.value)} placeholder="—" className="h-11 bg-background" />
        </div>
      </div>
      <Input
        value={serialNumber}
        onChange={(e) => setSerialNumber(e.target.value)}
        placeholder="Sériové číslo"
        className="h-11 bg-background"
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Datum výdeje *</label>
          <Input type="date" value={issuedAt} onChange={(e) => handleIssuedAtChange(e.target.value)} className="h-11 bg-background" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Výměna do</label>
          <Input type="date" value={replaceBy} onChange={(e) => setReplaceBy(e.target.value)} className="h-11 bg-background" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground ml-1">Kontrola do</label>
          <Input type="date" value={nextInspectionAt} onChange={(e) => setNextInspectionAt(e.target.value)} className="h-11 bg-background" />
        </div>
      </div>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Poznámka (volitelná)"
        className="bg-background resize-none"
        rows={2}
      />
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>Zrušit</Button>
        <Button type="submit" disabled={!ppeItemId || !personId || !issuedAt || isPending}>Vydat</Button>
      </div>
    </form>
  );
}

function ReturnForm({
  assignment,
  onSave,
  onCancel,
  isPending,
}: {
  assignment: PpeAssignment;
  onSave: (data: PpeAssignmentUpdate) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [status, setStatus] = useState<PpeAssignmentUpdateStatus>(PpeAssignmentUpdateStatus.returned);
  const [returnedAt, setReturnedAt] = useState(new Date().toISOString().slice(0, 10));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ status, returnedAt: returnedAt || null });
      }}
      className="space-y-3"
    >
      <p className="text-sm text-muted-foreground">
        Vrácení výdeje: <strong>{assignment.ppeNameSnapshot}</strong> – {assignment.personNameSnapshot}
      </p>
      <Select value={status} onValueChange={(v) => setStatus(v as PpeAssignmentUpdateStatus)}>
        <SelectTrigger className="h-11 bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="returned">Vráceno</SelectItem>
          <SelectItem value="damaged">Poškozeno</SelectItem>
          <SelectItem value="lost">Ztraceno</SelectItem>
          <SelectItem value="disposed">Zlikvidováno</SelectItem>
        </SelectContent>
      </Select>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground ml-1">Datum vrácení</label>
        <Input type="date" value={returnedAt} onChange={(e) => setReturnedAt(e.target.value)} className="h-11 bg-background" />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>Zrušit</Button>
        <Button type="submit" disabled={isPending}>Potvrdit vrácení</Button>
      </div>
    </form>
  );
}

export default function Oopp() {
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const prefillPersonId = searchParams.get("personId") ? parseInt(searchParams.get("personId")!) : null;

  const [tab, setTab] = useState<Tab>("vydeje");
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItem, setEditingItem] = useState<PpeItem | null>(null);
  const [returningId, setReturningId] = useState<number | null>(null);
  const [sharingAssignmentId, setSharingAssignmentId] = useState<number | null>(null);
  const [viewingSignatureId, setViewingSignatureId] = useState<number | null>(null);

  const [filterPerson, setFilterPerson] = useState(prefillPersonId ? String(prefillPersonId) : "_all");
  const [filterStatus, setFilterStatus] = useState("_all");
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [filterUnconfirmed, setFilterUnconfirmed] = useState(false);
  const [filterIssuedFrom, setFilterIssuedFrom] = useState("");
  const [filterIssuedTo, setFilterIssuedTo] = useState("");
  const [filterIncludeNoDate, setFilterIncludeNoDate] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [exportFormat, setExportFormat] = useState<"pdf" | "csv">("pdf");
  const [exporting, setExporting] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuth();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const [, setLocation] = useLocation();

  const { data: items, isLoading: itemsLoading } = useListPpeItems(
    { includeArchived },
    { query: { queryKey: getListPpeItemsQueryKey({ includeArchived }) } },
  );
  const { data: assignments, isLoading: assignmentsLoading } = useListPpeAssignments(
    {},
    { query: { queryKey: getListPpeAssignmentsQueryKey({}) } },
  );
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const createItem = useCreatePpeItem();
  const updateItem = useUpdatePpeItem();
  const archiveItem = useArchivePpeItem();
  const createAssignment = useCreatePpeAssignment();
  const updateAssignment = useUpdatePpeAssignment();

  const activeItems = useMemo(() => (items ?? []).filter((i) => i.active), [items]);

  const summary = useMemo(() => {
    if (!assignments) return { total: 0, overdue: 0, unconfirmed: 0 };
    const issued = assignments.filter((a) => a.status === "issued");
    return {
      total: issued.length,
      overdue: issued.filter((a) => isPpeOverdue(a)).length,
      unconfirmed: issued.filter((a) => !a.handoverDocument).length,
    };
  }, [assignments]);

  const filteredAssignments = useMemo(() => {
    if (!assignments) return [];
    return assignments.filter((a) => {
      if (filterPerson !== "_all" && a.personId !== parseInt(filterPerson)) return false;
      if (filterStatus !== "_all" && a.status !== filterStatus) return false;
      if (filterUnconfirmed && (a.status !== "issued" || !!a.handoverDocument || !!a.employeeConfirmedAt)) return false;
      if (filterIssuedFrom || filterIssuedTo) {
        if (!a.issuedAt) {
          if (!filterIncludeNoDate) return false;
        } else {
          if (filterIssuedFrom && a.issuedAt < filterIssuedFrom) return false;
          if (filterIssuedTo && a.issuedAt > filterIssuedTo) return false;
        }
      }
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        if (
          !a.ppeNameSnapshot.toLowerCase().includes(term) &&
          !a.personNameSnapshot.toLowerCase().includes(term) &&
          !(a.serialNumber?.toLowerCase().includes(term)) &&
          !(a.size?.toLowerCase().includes(term))
        ) return false;
      }
      return true;
    });
  }, [assignments, filterPerson, filterStatus, filterOverdue, filterUnconfirmed, filterIssuedFrom, filterIssuedTo, filterIncludeNoDate, searchTerm]);

  const [signingId, setSigningId] = useState<number | null>(null);
  const signHandover = useSignPpeHandover();
  const signingAssignment = assignments?.find((a) => a.id === signingId) ?? null;

  const returningAssignment = assignments?.find((a) => a.id === returningId) ?? null;

  const handleCreateItem = (data: Parameters<typeof createItem.mutate>[0]["data"]) => {
    createItem.mutate({ data }, {
      onSuccess: () => {
        setShowItemForm(false);
        invalidateData(queryClient, "ppe");
        toast({ title: "Pomůcka přidána do katalogu" });
      },
      onError: () => toast({ title: "Nepodařilo se přidat pomůcku", variant: "destructive" }),
    });
  };

  const handleUpdateItem = (id: number, data: Parameters<typeof updateItem.mutate>[0]["data"]) => {
    updateItem.mutate({ id, data }, {
      onSuccess: () => {
        setEditingItem(null);
        invalidateData(queryClient, "ppe");
        toast({ title: "Pomůcka aktualizována" });
      },
      onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
    });
  };

  const handleArchiveItem = (item: PpeItem) => {
    openConfirm(`Archivovat pomůcku „${item.name}"? Stávající výdeje zůstanou beze změny.`, () => {
      archiveItem.mutate({ id: item.id }, {
        onSuccess: () => {
          invalidateData(queryClient, "ppe");
          toast({ title: "Pomůcka archivována" });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Nepodařilo se archivovat pomůcku";
          toast({ title: "Nelze archivovat pomůcku", description: msg, variant: "destructive" });
        },
      });
    });
  };

  const handleReactivateItem = (item: PpeItem) => {
    updateItem.mutate({ id: item.id, data: { ...item, active: true, description: item.description ?? null, notes: item.notes ?? null, defaultReplacementMonths: item.defaultReplacementMonths ?? null, defaultInspectionMonths: item.defaultInspectionMonths ?? null } }, {
      onSuccess: () => {
        invalidateData(queryClient, "ppe");
        toast({ title: "Pomůcka znovu aktivována" });
      },
      onError: () => toast({ title: "Nepodařilo se aktivovat", variant: "destructive" }),
    });
  };

  const handleCreateAssignment = (data: Parameters<typeof createAssignment.mutate>[0]["data"]) => {
    createAssignment.mutate({ data }, {
      onSuccess: () => {
        setShowAssignForm(false);
        invalidateData(queryClient, "ppe", "people");
        toast({ title: "OOPP vydáno" });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? "Nepodařilo se vydat OOPP";
        toast({ title: msg, variant: "destructive" });
      },
    });
  };

  const handleReturn = (data: PpeAssignmentUpdate) => {
    if (!returningId) return;
    updateAssignment.mutate({ id: returningId, data }, {
      onSuccess: () => {
        setReturningId(null);
        invalidateData(queryClient, "ppe", "people");
        toast({ title: "Výdej uzavřen" });
      },
      onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
    });
  };

  const hasDateFilter = !!filterIssuedFrom || !!filterIssuedTo;
  const hasFilters = filterPerson !== "_all" || filterStatus !== "_all" || filterOverdue || filterUnconfirmed || !!searchTerm || hasDateFilter || (hasDateFilter && !filterIncludeNoDate);

  const handleExport = async (fmt: "pdf" | "csv") => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ format: fmt });
      if (filterPerson !== "_all") params.set("personId", filterPerson);
      if (filterStatus !== "_all") params.set("status", filterStatus);
      if (filterOverdue) params.set("overdue", "true");
      if (filterIssuedFrom) params.set("issuedFrom", filterIssuedFrom);
      if (filterIssuedTo) params.set("issuedTo", filterIssuedTo);
      if (hasDateFilter && !filterIncludeNoDate) params.set("excludeNoDate", "true");
      const res = await fetch(`/api/ppe/assignments/export?${params.toString()}`);
      if (!res.ok) throw new Error("Export selhal");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const today = new Date().toISOString().slice(0, 10);
      a.download = `oopp-vydeje-${today}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export se nezdařil", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto w-full">
      <Link href="/stroje" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-4 w-4" /> Zpět na stroje
      </Link>

      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" /> OOPP
        </h1>
        {can("write") && tab === "vydeje" && activeItems.length > 0 && (
          <Button onClick={() => setShowAssignForm((s) => !s)} className="h-10">
            <Plus className="h-5 w-5 mr-2" /> Vydat OOPP
          </Button>
        )}
        {can("write") && tab === "katalog" && (
          <Button onClick={() => { setShowItemForm((s) => !s); setEditingItem(null); }} className="h-10">
            <Plus className="h-5 w-5 mr-2" /> Přidat pomůcku
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b mb-6">
        {(["vydeje", "katalog"] as const).map((t) => (
          <button
            key={t}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab(t)}
          >
            {t === "vydeje" ? "Výdeje" : "Katalog OOPP"}
            {t === "vydeje" && assignments && (
              <span className="ml-1.5 text-xs text-muted-foreground">({summary.total})</span>
            )}
            {t === "katalog" && items && (
              <span className="ml-1.5 text-xs text-muted-foreground">({activeItems.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* ───── VÝDEJE TAB ───── */}
      {tab === "vydeje" && (
        <>
          {/* Summary cards */}
          {assignments && assignments.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-5">
              <button
                className={`rounded-xl border p-3 text-left transition-colors ${filterStatus === "issued" && !filterOverdue ? "border-primary/50 bg-primary/10" : "border-border bg-muted/30 hover:bg-muted/60"}`}
                onClick={() => { setFilterStatus(filterStatus === "issued" && !filterOverdue ? "_all" : "issued"); setFilterOverdue(false); }}
              >
                <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-xs font-medium">Aktuálně vydáno</span>
                </div>
                <div className="text-2xl font-bold">{summary.total}</div>
              </button>
              <button
                className={`rounded-xl border p-3 text-left transition-colors ${filterOverdue ? "border-destructive/50 bg-destructive/10" : "border-border bg-muted/30 hover:bg-muted/60"}`}
                onClick={() => setFilterOverdue((v) => !v)}
              >
                <div className="flex items-center gap-1.5 text-destructive mb-1">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-xs font-medium">Po termínu</span>
                </div>
                <div className="text-2xl font-bold">{summary.overdue}</div>
              </button>
              <button
                className={`rounded-xl border p-3 text-left transition-colors ${filterUnconfirmed ? "border-amber-400 bg-amber-50 dark:bg-amber-900/20" : "border-border bg-muted/30 hover:bg-muted/60"}`}
                onClick={() => setFilterUnconfirmed((v) => !v)}
              >
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 mb-1">
                  <Clock className="h-4 w-4" />
                  <span className="text-xs font-medium">Bez potvrzení</span>
                </div>
                <div className="text-2xl font-bold">{summary.unconfirmed}</div>
              </button>
            </div>
          )}

          {/* Issue form */}
          {showAssignForm && (
            <Card className="mb-6 border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <h3 className="font-semibold mb-3">Vydat OOPP</h3>
                {activeItems.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <p className="text-sm">Katalog je prázdný. Nejdříve přidejte pomůcky v záložce <strong>Katalog OOPP</strong>.</p>
                    <Button variant="link" size="sm" onClick={() => { setTab("katalog"); setShowAssignForm(false); }}>
                      Přejít do katalogu
                    </Button>
                  </div>
                ) : (
                  <AssignmentForm
                    items={activeItems}
                    people={people ?? []}
                    prefillPersonId={prefillPersonId}
                    onSave={handleCreateAssignment}
                    onCancel={() => setShowAssignForm(false)}
                    isPending={createAssignment.isPending}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Return modal */}
          {returningAssignment && (
            <Card className="mb-6 border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20">
              <CardContent className="p-4">
                <ReturnForm
                  assignment={returningAssignment}
                  onSave={handleReturn}
                  onCancel={() => setReturningId(null)}
                  isPending={updateAssignment.isPending}
                />
              </CardContent>
            </Card>
          )}

          {/* Share sign link dialog */}
          {sharingAssignmentId && (
            (() => {
              const a = assignments?.find((x) => x.id === sharingAssignmentId);
              return a ? <ShareSignDialog assignment={a} onClose={() => setSharingAssignmentId(null)} /> : null;
            })()
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-2 mb-4">
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Hledat..."
              className="h-9 w-36 text-sm"
            />
            <Select value={filterPerson} onValueChange={setFilterPerson}>
              <SelectTrigger className="h-9 w-auto min-w-[130px] text-sm">
                <SelectValue placeholder="Zaměstnanec: Vše" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">Zaměstnanec: Vše</SelectItem>
                {(people ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="h-9 w-auto min-w-[120px] text-sm">
                <SelectValue placeholder="Stav: Vše" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">Stav: Vše</SelectItem>
                {PPE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{PPE_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Vydáno od</label>
              <Input
                type="date"
                value={filterIssuedFrom}
                onChange={(e) => setFilterIssuedFrom(e.target.value)}
                className="h-9 w-36 text-sm"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-muted-foreground whitespace-nowrap">do</label>
              <Input
                type="date"
                value={filterIssuedTo}
                onChange={(e) => setFilterIssuedTo(e.target.value)}
                className="h-9 w-36 text-sm"
              />
            </div>
            {hasDateFilter && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-muted-foreground whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={filterIncludeNoDate}
                  onChange={(e) => setFilterIncludeNoDate(e.target.checked)}
                  className="accent-primary"
                />
                Zahrnout bez data vydání
              </label>
            )}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-muted-foreground"
                onClick={() => { setFilterPerson("_all"); setFilterStatus("_all"); setFilterOverdue(false); setFilterUnconfirmed(false); setFilterIssuedFrom(""); setFilterIssuedTo(""); setFilterIncludeNoDate(true); setSearchTerm(""); }}
              >
                Zrušit filtry
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as "pdf" | "csv")}>
                <SelectTrigger className="h-9 w-[80px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                disabled={exporting}
                onClick={() => handleExport(exportFormat)}
              >
                <Download className="h-4 w-4" />
                {exporting ? "Exportuji…" : "Export"}
              </Button>
            </div>
          </div>

          {/* Assignment list */}
          {assignmentsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full mb-3" />)
          ) : filteredAssignments.length > 0 ? (
            <div className="space-y-3">
              {filteredAssignments.map((a) => (
                <Card key={a.id} className="hover:bg-muted/30 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold">{a.ppeNameSnapshot}</span>
                          <PpeStatusBadge status={a.status} />
                          <OverdueBadge assignment={a} />
                          {a.employeeConfirmedAt ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 font-medium">
                              <CheckCircle2 className="h-3 w-3" /> Podepsáno {formatPpeDate(a.employeeConfirmedAt)}
                            </span>
                          ) : a.status === "issued" ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium">
                              Bez potvrzení
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground mb-1">
                          <User className="h-3.5 w-3.5 shrink-0" />
                          <button
                            className="hover:text-primary transition-colors truncate"
                            onClick={() => setLocation(`/stroje/oopp?personId=${a.personId}`)}
                          >
                            {a.personNameSnapshot}
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>Vydáno: {formatPpeDate(a.issuedAt)}</span>
                          {a.replaceBy && <span>Výměna: {formatPpeDate(a.replaceBy)}</span>}
                          {a.nextInspectionAt && <span>Kontrola: {formatPpeDate(a.nextInspectionAt)}</span>}
                          {a.returnedAt && <span>Vráceno: {formatPpeDate(a.returnedAt)}</span>}
                          {a.quantity > 1 && <span>Počet: {a.quantity}</span>}
                          {a.size && <span>Vel.: {a.size}</span>}
                          {a.serialNumber && <span>SN: {a.serialNumber}</span>}
                        </div>
                        {a.notes && <p className="text-xs text-muted-foreground mt-1 italic">{a.notes}</p>}
                        {a.handoverDocument && (
                          <div className="mt-2 rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-2 text-xs">
                            <div className="flex items-center gap-1.5 text-green-700 dark:text-green-400 font-semibold mb-0.5">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Podepsáno – protokol {a.handoverDocument.documentNumber}
                            </div>
                            <div className="text-muted-foreground mb-1.5">
                              {a.handoverDocument.signatoryName} · {new Date(a.handoverDocument.signedAt).toLocaleString("cs-CZ")}
                            </div>
                            <div className="flex gap-2 flex-wrap">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => window.open(`/api/ppe/assignments/${a.id}/handover-pdf`, "_blank")}
                              >
                                <FileText className="h-3.5 w-3.5 mr-1" /> Protokol PDF
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => window.open(`/api/ppe/assignments/${a.id}/signature`, "_blank")}
                              >
                                <Image className="h-3.5 w-3.5 mr-1" /> Podpis
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                      {can("write") && a.status === "issued" && (
                        <div className="flex flex-col gap-2 shrink-0">
                          {!a.handoverDocument && (
                            <Button
                              variant="default"
                              size="sm"
                              className="shrink-0"
                              onClick={() => setSigningId(a.id)}
                            >
                              <PenLine className="h-4 w-4 mr-1" /> Podepsat převzetí
                            </Button>
                          )}
                          {(a as any).hasSignature && !a.handoverDocument && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => setViewingSignatureId(viewingSignatureId === a.id ? null : a.id)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Podpis</span>
                            </Button>
                          )}
                          {!a.employeeConfirmedAt && !a.handoverDocument && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => setSharingAssignmentId(sharingAssignmentId === a.id ? null : a.id)}
                            >
                              <QrCode className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Podpis</span>
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setReturningId(a.id)}
                          >
                            Vrátit
                          </Button>
                        </div>
                      )}
                    </div>
                    {viewingSignatureId === a.id && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <p className="text-xs text-muted-foreground mb-2">Podpis zaměstnance</p>
                        <img
                          src={`/api/ppe/assignments/${a.id}/signature`}
                          alt={`Podpis – ${a.personNameSnapshot}`}
                          className="max-h-32 border rounded bg-white p-1"
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
              <ShieldCheck className="h-12 w-12 mx-auto mb-4 opacity-20" />
              {assignments && assignments.length > 0 ? (
                <>
                  <p>Žádný výdej nevyhovuje filtrům.</p>
                  <Button variant="link" className="mt-2" onClick={() => { setFilterPerson("_all"); setFilterStatus("_all"); setFilterOverdue(false); setFilterIssuedFrom(""); setFilterIssuedTo(""); setSearchTerm(""); }}>
                    Zrušit filtry
                  </Button>
                </>
              ) : (
                <>
                  <p>Zatím žádné výdeje.</p>
                  {activeItems.length === 0 && (
                    <p className="text-sm mt-1">Nejdříve přidejte pomůcky do katalogu.</p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ───── KATALOG TAB ───── */}
      {tab === "katalog" && (
        <>
          {showItemForm && !editingItem && (
            <Card className="mb-6 border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <h3 className="font-semibold mb-3">Nová pomůcka</h3>
                <ItemForm
                  onSave={handleCreateItem}
                  onCancel={() => setShowItemForm(false)}
                  isPending={createItem.isPending}
                />
              </CardContent>
            </Card>
          )}

          <div className="flex items-center gap-2 mb-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="rounded"
              />
              Zobrazit archivované
            </label>
          </div>

          {itemsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full mb-3" />)
          ) : (items ?? []).length > 0 ? (
            <div className="space-y-3">
              {(items ?? []).map((item) => (
                <Card key={item.id} className={`transition-colors ${item.active ? "hover:bg-muted/30" : "opacity-60"}`}>
                  <CardContent className="p-4">
                    {editingItem?.id === item.id ? (
                      <ItemForm
                        initial={item}
                        onSave={(data) => handleUpdateItem(item.id, data)}
                        onCancel={() => setEditingItem(null)}
                        isPending={updateItem.isPending}
                      />
                    ) : (
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="font-semibold">{item.name}</span>
                            <Badge variant="outline" className="text-xs">{PPE_CATEGORY_LABELS[item.category] ?? item.category}</Badge>
                            {!item.active && (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Archive className="h-3 w-3" /> Archivováno
                              </span>
                            )}
                          </div>
                          {item.description && (
                            <p className="text-sm text-muted-foreground truncate">{item.description}</p>
                          )}
                          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1">
                            {item.defaultReplacementMonths && (
                              <span>Výměna: {item.defaultReplacementMonths} měs.</span>
                            )}
                            {item.defaultInspectionMonths && (
                              <span>Kontrola: {item.defaultInspectionMonths} měs.</span>
                            )}
                          </div>
                          {item.notes && <p className="text-xs text-muted-foreground mt-1 italic">{item.notes}</p>}
                        </div>
                        {can("write") && (
                          <div className="flex gap-2 shrink-0">
                            <Button variant="outline" size="sm" onClick={() => setEditingItem(item)}>Upravit</Button>
                            {item.active ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-muted-foreground"
                                onClick={() => handleArchiveItem(item)}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleReactivateItem(item)}
                              >
                                Aktivovat
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p>Katalog OOPP je prázdný.</p>
              {can("write") && (
                <Button variant="link" className="mt-2" onClick={() => setShowItemForm(true)}>
                  Přidat první pomůcku
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog {...dialogProps} />

      {/* ── Signing Dialog ── */}
      <SigningDialog
        assignment={signingAssignment}
        onClose={() => setSigningId(null)}
        onSigned={() => {
          setSigningId(null);
          invalidateData(queryClient, "ppe", "people");
          toast({ title: "Protokol o předání podepsán" });
        }}
      />
    </div>
  );
}

const CONFIRMATION_TEXT =
  "Svým podpisem potvrzuji, že jsem převzal/a výše uvedené ochranné pracovní pomůcky (OOPP). " +
  "Zavazuji se je používat v souladu s pokyny výrobce a zaměstnavatele a chránit je před poškozením.";

function SigningDialog({
  assignment,
  onClose,
  onSigned,
}: {
  assignment: PpeAssignment | null;
  onClose: () => void;
  onSigned: () => void;
}) {
  const [signatoryName, setSignatoryName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const signHandover = useSignPpeHandover();
  const { toast } = useToast();

  const reset = () => {
    setSignatoryName("");
    setAccepted(false);
    setSignatureDataUrl(null);
  };

  const canSubmit = !!signatoryName.trim() && accepted && !!signatureDataUrl && !signHandover.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignment || !canSubmit || !signatureDataUrl) return;
    signHandover.mutate(
      {
        id: assignment.id,
        data: {
          signatureDataUrl,
          signatoryName: signatoryName.trim(),
          confirmationText: CONFIRMATION_TEXT,
          confirmationAccepted: true,
        },
      },
      {
        onSuccess: () => {
          reset();
          onSigned();
        },
        onError: (err: unknown) => {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Nepodařilo se uložit podpis";
          toast({ title: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Dialog
      open={!!assignment}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5" /> Podpis převzetí OOPP
          </DialogTitle>
        </DialogHeader>

        {assignment && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="font-semibold">{assignment.ppeNameSnapshot}</div>
              <div className="text-muted-foreground">
                Zaměstnanec: {assignment.personNameSnapshot}
              </div>
              {assignment.quantity > 1 && (
                <div className="text-muted-foreground">Počet: {assignment.quantity} ks</div>
              )}
              {assignment.size && <div className="text-muted-foreground">Velikost: {assignment.size}</div>}
              {assignment.serialNumber && (
                <div className="text-muted-foreground">SN: {assignment.serialNumber}</div>
              )}
            </div>

            <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-muted-foreground leading-relaxed">
              {CONFIRMATION_TEXT}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="signatoryName">Jméno podepisujícího *</Label>
              <Input
                id="signatoryName"
                value={signatoryName}
                onChange={(e) => setSignatoryName(e.target.value)}
                placeholder="Celé jméno zaměstnance"
                className="h-11 bg-background"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Podpis *</Label>
              <InlineSignaturePad onSignature={setSignatureDataUrl} />
            </div>

            <div className="flex items-start gap-2.5">
              <input
                type="checkbox"
                id="accepted"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input"
              />
              <label htmlFor="accepted" className="text-sm leading-snug cursor-pointer select-none">
                Souhlasím s výše uvedeným textem potvrzení a beru na vědomí svá práva a povinnosti ohledně OOPP.
              </label>
            </div>

            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => { reset(); onClose(); }}>
                Zrušit
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {signHandover.isPending ? "Ukládám…" : "Potvrdit a podepsat"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function initCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 480;
  const h = rect.height || 160;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1e3a8a";
}

function InlineSignaturePad({ onSignature }: { onSignature: (dataUrl: string | null) => void }) {
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const callbackRef = useRef<HTMLCanvasElement | null>(null);
  const setCanvasRef = (el: HTMLCanvasElement | null) => {
    callbackRef.current = el;
    if (el) initCanvas(el);
  };

  const getPos = (clientX: number, clientY: number, target: HTMLCanvasElement) => {
    const rect = target.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const draw = (x: number, y: number) => {
    const canvas = callbackRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !lastRef.current) return;
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastRef.current = { x, y };
    setHasInk(true);
    onSignature(canvas!.toDataURL("image/png"));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore in test env */ }
    drawingRef.current = true;
    const p = getPos(e.clientX, e.clientY, e.currentTarget);
    lastRef.current = p;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    draw(e.clientX - e.currentTarget.getBoundingClientRect().left, e.clientY - e.currentTarget.getBoundingClientRect().top);
  };
  const onPointerEnd = () => { drawingRef.current = false; lastRef.current = null; };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    const p = getPos(e.clientX, e.clientY, e.currentTarget);
    lastRef.current = p;
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || e.buttons === 0) return;
    const canvas = e.currentTarget;
    draw(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
  };
  const onMouseUp = () => { drawingRef.current = false; lastRef.current = null; };

  const clear = () => {
    const canvas = callbackRef.current;
    if (!canvas) return;
    initCanvas(canvas);
    setHasInk(false);
    onSignature(null);
  };

  return (
    <div>
      <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-white overflow-hidden relative">
        <canvas
          ref={setCanvasRef}
          data-testid="signature-canvas"
          className="w-full touch-none"
          style={{ height: "160px", display: "block", touchAction: "none", cursor: "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerLeave={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
        {!hasInk && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-muted-foreground select-none">Podepište se prstem nebo myší</span>
          </div>
        )}
      </div>
      <div className="flex justify-end mt-1">
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!hasInk} className="h-7 text-xs text-muted-foreground">
          Smazat podpis
        </Button>
      </div>
    </div>
  );
}
