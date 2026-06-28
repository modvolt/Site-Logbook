import { useState, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useListPpeItems,
  useCreatePpeItem,
  useUpdatePpeItem,
  useArchivePpeItem,
  useListPpeAssignments,
  useCreatePpeAssignment,
  useUpdatePpeAssignment,
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
import {
  ArrowLeft, Plus, ShieldCheck, AlertCircle, Clock, Archive, CheckCircle2, ChevronRight, User, Package
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

  const [filterPerson, setFilterPerson] = useState(prefillPersonId ? String(prefillPersonId) : "_all");
  const [filterStatus, setFilterStatus] = useState("_all");
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [filterUnconfirmed, setFilterUnconfirmed] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
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
      unconfirmed: issued.filter((a) => !a.employeeConfirmedAt).length,
    };
  }, [assignments]);

  const filteredAssignments = useMemo(() => {
    if (!assignments) return [];
    return assignments.filter((a) => {
      if (filterPerson !== "_all" && a.personId !== parseInt(filterPerson)) return false;
      if (filterStatus !== "_all" && a.status !== filterStatus) return false;
      if (filterOverdue && !isPpeOverdue(a)) return false;
      if (filterUnconfirmed && (a.status !== "issued" || !!a.employeeConfirmedAt)) return false;
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
  }, [assignments, filterPerson, filterStatus, filterOverdue, filterUnconfirmed, searchTerm]);

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
        onError: () => toast({ title: "Nepodařilo se archivovat", variant: "destructive" }),
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

  const hasFilters = filterPerson !== "_all" || filterStatus !== "_all" || filterOverdue || filterUnconfirmed || !!searchTerm;

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
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-muted-foreground"
                onClick={() => { setFilterPerson("_all"); setFilterStatus("_all"); setFilterOverdue(false); setFilterUnconfirmed(false); setSearchTerm(""); }}
              >
                Zrušit filtry
              </Button>
            )}
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
                          {!a.employeeConfirmedAt && a.status === "issued" && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium">
                              Bez potvrzení
                            </span>
                          )}
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
                      </div>
                      {can("write") && a.status === "issued" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setReturningId(a.id)}
                        >
                          Vrátit
                        </Button>
                      )}
                    </div>
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
                  <Button variant="link" className="mt-2" onClick={() => { setFilterPerson("_all"); setFilterStatus("_all"); setFilterOverdue(false); setSearchTerm(""); }}>
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
    </div>
  );
}
