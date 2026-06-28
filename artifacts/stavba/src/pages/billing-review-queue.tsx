import { useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import {
  useListBillingReviewQueue,
  getListBillingReviewQueueQueryKey,
  useBulkConfirmReviewLines,
  useSkipReviewLines,
  useReturnReviewLines,
  useUpdateCostDocumentLine,
  useAssignWarehouseItemToReviewLine,
  useCreateWarehouseItem,
  useListWarehouseItems,
  getListWarehouseItemsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  type ReviewQueueItem,
  type BulkReviewDiff,
  ListBillingReviewQueueReason,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  BriefcaseBusiness,
  TrendingUp,
  PackageX,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  SquareCheck,
  Square,
  SkipForward,
  Undo2,
  Pencil,
  X,
  Check,
  Package,
  Search,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { invalidateData } from "@/lib/query-invalidation";

// ---------------------------------------------------------------------------
// Reason badge config
// ---------------------------------------------------------------------------

const REASON_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.FC<{ className?: string }> }
> = {
  needs_review: {
    label: "Ke kontrole",
    color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    icon: AlertTriangle,
  },
  low_confidence: {
    label: "Nízká jistota AI",
    color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
    icon: Sparkles,
  },
  missing_job: {
    label: "Chybí zakázka",
    color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    icon: BriefcaseBusiness,
  },
  missing_warehouse_item: {
    label: "Chybí karta skladu",
    color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
    icon: PackageX,
  },
  price_jump: {
    label: "Skok ceny",
    color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    icon: TrendingUp,
  },
};

function ReasonBadge({ reason }: { reason: string }) {
  const cfg = REASON_CONFIG[reason];
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "–";
  return n.toLocaleString("cs-CZ", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("cs-CZ", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} %`;
}

function pctColor(n: number | null | undefined): string {
  if (n == null) return "";
  if (n > 20) return "text-red-600 dark:text-red-400 font-semibold";
  if (n < -20) return "text-green-600 dark:text-green-400 font-semibold";
  return "text-muted-foreground";
}

// ---------------------------------------------------------------------------
// Group by document
// ---------------------------------------------------------------------------

interface DocGroup {
  doc: ReviewQueueItem["document"];
  items: ReviewQueueItem[];
}

function groupByDocument(items: ReviewQueueItem[]): DocGroup[] {
  const map = new Map<number, DocGroup>();
  for (const item of items) {
    let group = map.get(item.document.id);
    if (!group) {
      group = { doc: item.document, items: [] };
      map.set(item.document.id, group);
    }
    group.items.push(item);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Inline field editor (click-to-edit)
// ---------------------------------------------------------------------------

function InlineEdit({
  value,
  type = "text",
  onSave,
  className = "",
}: {
  value: string;
  type?: "text" | "number";
  onSave: (v: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(value);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function handleSave() {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") void handleSave();
    if (e.key === "Escape") setEditing(false);
  }

  if (!editing) {
    return (
      <button
        className={`group flex items-center gap-1 text-left hover:text-foreground transition-colors ${className}`}
        onClick={startEdit}
        title="Klikněte pro úpravu"
      >
        <span>{value}</span>
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-50 flex-shrink-0" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        className="h-6 px-1 py-0 text-xs w-full min-w-0"
        disabled={saving}
      />
      <button
        className="text-emerald-600 dark:text-emerald-400 disabled:opacity-50"
        onClick={() => void handleSave()}
        disabled={saving}
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        className="text-muted-foreground"
        onClick={() => setEditing(false)}
        disabled={saving}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff dialog — shows per-job list when affectedJobIds present
// ---------------------------------------------------------------------------

function ConfirmDiffDialog({
  diff,
  open,
  onClose,
  onConfirm,
  confirming,
}: {
  diff: BulkReviewDiff | null;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Hromadné potvrzení</DialogTitle>
          <DialogDescription>Souhrn změn, které budou provedeny:</DialogDescription>
        </DialogHeader>
        {diff && (
          <div className="space-y-2 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Celkem vybraných</span>
              <span className="font-medium">{diff.total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ke potvrzení</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {diff.toConfirm}
              </span>
            </div>
            {diff.alreadyConfirmed > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Již potvrzeno</span>
                <span className="font-medium">{diff.alreadyConfirmed}</span>
              </div>
            )}
            {diff.withJobAssigned > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-emerald-700 dark:text-emerald-400">
                  <span>✓ Se zakázkou (propíše se po schválení)</span>
                  <span className="font-medium">{diff.withJobAssigned}</span>
                </div>
                {diff.affectedJobIds.length > 0 && (
                  <div className="pl-4 text-xs text-muted-foreground leading-snug">
                    Zakázky:{" "}
                    {diff.affectedJobIds.map((id) => `#${id}`).join(", ")}
                  </div>
                )}
              </div>
            )}
            {diff.priceJumps > 0 && (
              <div className="flex justify-between text-amber-600 dark:text-amber-400">
                <span>⚠ Skok ceny (&gt;20 %)</span>
                <span className="font-medium">{diff.priceJumps}</span>
              </div>
            )}
            {diff.missingJobCount > 0 && (
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span>⚠ Bez zakázky</span>
                <span className="font-medium">{diff.missingJobCount}</span>
              </div>
            )}
            {diff.missingWarehouseItemCount > 0 && (
              <div className="flex justify-between text-rose-600 dark:text-rose-400">
                <span>⚠ Bez karty skladu (k vytvoření po schválení)</span>
                <span className="font-medium">{diff.missingWarehouseItemCount}</span>
              </div>
            )}
            {diff.stillUnresolved > 0 && (
              <div className="flex justify-between text-orange-600 dark:text-orange-400">
                <span>⚠ Zůstane ve frontě po potvrzení</span>
                <span className="font-medium">{diff.stillUnresolved}</span>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={confirming}>
            Zrušit
          </Button>
          <Button
            onClick={onConfirm}
            disabled={confirming || !diff || diff.toConfirm === 0}
          >
            {confirming ? "Potvrzuji…" : `Potvrdit (${diff?.toConfirm ?? 0})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Skip dialog
// ---------------------------------------------------------------------------

function SkipDialog({
  open,
  onClose,
  onSkip,
  skipping,
  count,
}: {
  open: boolean;
  onClose: () => void;
  onSkip: (reason: string) => void;
  skipping: boolean;
  count: number;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Přeskočit {count} {count === 1 ? "řádek" : count < 5 ? "řádky" : "řádků"}</DialogTitle>
          <DialogDescription>
            Řádky budou označeny jako "nevyfakturovat" a přesunuty mimo frontu. Uveďte důvod.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="Důvod přeskočení (nepovinné)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="text-sm min-h-[80px]"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={skipping}>
            Zrušit
          </Button>
          <Button
            variant="secondary"
            onClick={() => onSkip(reason || "bez důvodu")}
            disabled={skipping}
          >
            <SkipForward className="h-4 w-4 mr-1.5" />
            {skipping ? "Přeskakuji…" : "Přeskočit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Warehouse picker dialog — search, assign existing, or create new card
// ---------------------------------------------------------------------------

function WarehousePickerDialog({
  open,
  onClose,
  lineDescription,
  onAssign,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  lineDescription: string;
  onAssign: (warehouseItemId: number) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(lineDescription);
  const [assigningId, setAssigningId] = useState<number | null>(null);

  const warehouseParams = {};
  const { data: allItems } = useListWarehouseItems(
    warehouseParams,
    { query: { enabled: open, queryKey: getListWarehouseItemsQueryKey(warehouseParams) } },
  );

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allItems ?? [];
    return (allItems ?? []).filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.code ?? "").toLowerCase().includes(q) ||
        (it.supplierSku ?? "").toLowerCase().includes(q),
    );
  }, [allItems, search]);

  function handleOpen(v: boolean) {
    if (!v) {
      onClose();
      setSearch("");
      setCreating(false);
      setNewName(lineDescription);
      setAssigningId(null);
    }
  }

  async function handleAssign(id: number) {
    setAssigningId(id);
    try {
      await onAssign(id);
      handleOpen(false);
    } finally {
      setAssigningId(null);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    await onCreate(newName.trim());
    handleOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Přiřadit skladovou kartu</DialogTitle>
          <DialogDescription>
            Vyberte existující kartu nebo vytvořte novou pro: <strong>{lineDescription}</strong>
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Nová karta bude vytvořena s nulovou zásobou (bez pohybu). Propojení se dokladovým řádkem se nastaví automaticky.
            </p>
            <Input
              placeholder="Název nové karty"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>
        ) : (
          <div className="space-y-2 py-2">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Hledat kartu…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-52 overflow-y-auto space-y-1 rounded border p-1">
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {search ? "Žádná shoda" : "Načítám…"}
                </p>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    className="w-full flex items-center justify-between px-3 py-2 rounded text-sm hover:bg-muted transition-colors text-left"
                    onClick={() => void handleAssign(item.id)}
                    disabled={busy || assigningId != null}
                  >
                    <span className="font-medium truncate flex-1">{item.name}</span>
                    <span className="ml-3 text-xs text-muted-foreground flex-shrink-0">
                      {item.quantity ?? 0} {item.unit ?? "ks"}
                    </span>
                    {assigningId === item.id && (
                      <span className="ml-2 text-xs text-muted-foreground">…</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => handleOpen(false)} disabled={busy} className="sm:mr-auto">
            Zrušit
          </Button>
          {creating ? (
            <>
              <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
                Zpět
              </Button>
              <Button onClick={() => void handleCreate()} disabled={busy || !newName.trim()}>
                <Plus className="h-4 w-4 mr-1.5" />
                {busy ? "Vytvářím…" : "Vytvořit kartu"}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              onClick={() => { setCreating(true); setNewName(lineDescription); }}
              disabled={busy}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              Nová karta
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Job picker dialog — arbitrary job assignment
// ---------------------------------------------------------------------------

function JobPickerDialog({
  open,
  onClose,
  currentJobId,
  onAssign,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  currentJobId: number | null | undefined;
  onAssign: (jobId: number | null) => Promise<void>;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");

  const jobsParams = {};
  const { data: allJobs } = useListJobs(
    jobsParams,
    { query: { enabled: open, queryKey: getListJobsQueryKey(jobsParams) } },
  );

  const displayJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allJobs ?? [];
    return (allJobs ?? []).filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        String(j.id).includes(q),
    );
  }, [allJobs, search]);

  function handleClose() {
    onClose();
    setSearch("");
  }

  async function handlePick(jobId: number) {
    await onAssign(jobId);
    handleClose();
  }

  async function handleClear() {
    await onAssign(null);
    handleClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Přiřadit zakázku</DialogTitle>
          <DialogDescription>
            Vyberte zakázku pro tento řádek dokladu.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Hledat zakázku…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
              autoFocus
            />
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1 rounded border p-1">
            {displayJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {search ? "Žádná shoda" : "Začněte psát pro vyhledání…"}
              </p>
            ) : (
              displayJobs.map((job) => (
                <button
                  key={job.id}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-muted transition-colors text-left ${job.id === currentJobId ? "bg-emerald-50 dark:bg-emerald-900/20" : ""}`}
                  onClick={() => void handlePick(job.id)}
                  disabled={busy}
                >
                  <span className="text-muted-foreground text-xs flex-shrink-0">#{job.id}</span>
                  <span className="font-medium truncate flex-1">{job.title}</span>
                  {job.id === currentJobId && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 flex-shrink-0">✓</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={busy} className="mr-auto">
            Zrušit
          </Button>
          {currentJobId != null && (
            <Button variant="ghost" className="text-destructive" onClick={() => void handleClear()} disabled={busy}>
              Odebrat zakázku
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Single line row
// ---------------------------------------------------------------------------

function LineRow({
  item,
  selected,
  onToggle,
  onConfirm,
  onAssignSuggestedJob,
  onOpenJobPicker,
  onOpenWarehousePicker,
  onSkip,
  onReturn,
  onEditDescription,
  onEditPrice,
  confirming,
  assigningJob,
  skipping,
  returning,
  warehouseAssigning,
  onOpen,
}: {
  item: ReviewQueueItem;
  selected: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onAssignSuggestedJob: () => void;
  onOpenJobPicker: () => void;
  onOpenWarehousePicker: () => void;
  onSkip: () => void;
  onReturn: () => void;
  onEditDescription: (v: string) => Promise<void>;
  onEditPrice: (v: string) => Promise<void>;
  confirming: boolean;
  assigningJob: boolean;
  skipping: boolean;
  returning: boolean;
  warehouseAssigning: boolean;
  onOpen: () => void;
}) {
  const hasSuggestedJob = item.suggestedJobId != null && item.jobId == null;
  const isSkipped = item.allocationType === "not_rebilled" && item.matchConfirmed;
  const needsWarehouse = item.reasons.includes("missing_warehouse_item");

  return (
    <tr className={`border-b last:border-0 transition-colors ${isSkipped ? "opacity-50 bg-muted/20" : "hover:bg-muted/30"}`}>
      <td className="px-3 py-2 w-8">
        {!item.matchConfirmed && (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label="Vybrat řádek"
          />
        )}
      </td>
      {/* Description — click-to-edit */}
      <td className="px-2 py-2 max-w-[220px]">
        <InlineEdit
          value={item.description}
          onSave={onEditDescription}
          className="font-medium text-sm leading-tight w-full"
        />
        <div className="flex flex-wrap gap-1 mt-1">
          {item.reasons.map((r) => (
            <ReasonBadge key={r} reason={r} />
          ))}
        </div>
      </td>
      {/* Warehouse match */}
      <td className="px-2 py-2 text-xs text-muted-foreground max-w-[140px]">
        {item.suggestedWarehouseItemName ? (
          <div className="flex items-center gap-1">
            <span className="text-foreground font-medium line-clamp-1">
              {item.suggestedWarehouseItemName}
            </span>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              onClick={onOpenWarehousePicker}
              disabled={warehouseAssigning}
              title="Změnit skladovou kartu"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        ) : needsWarehouse ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs text-rose-600 dark:text-rose-400 hover:text-rose-700"
            onClick={onOpenWarehousePicker}
            disabled={warehouseAssigning}
          >
            <Package className="h-3 w-3 mr-1" />
            {warehouseAssigning ? "…" : "Přiřadit"}
          </Button>
        ) : (
          <span className="italic">—</span>
        )}
      </td>
      {/* Assigned job */}
      <td className="px-2 py-2 text-xs max-w-[140px]">
        {item.jobId != null ? (
          <div className="flex items-center gap-1">
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              #{item.jobId}
            </span>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              onClick={onOpenJobPicker}
              disabled={assigningJob}
              title="Změnit zakázku"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        ) : hasSuggestedJob ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700"
              onClick={onAssignSuggestedJob}
              disabled={assigningJob}
            >
              <BriefcaseBusiness className="h-3 w-3 mr-1" />
              {assigningJob ? "…" : `#${item.suggestedJobId}`}
            </Button>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={onOpenJobPicker}
              disabled={assigningJob}
              title="Vybrat jinou zakázku"
            >
              <Search className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={onOpenJobPicker}
            disabled={assigningJob}
            title="Přiřadit zakázku"
          >
            <BriefcaseBusiness className="h-3 w-3 mr-1" />
            {assigningJob ? "…" : "Přiřadit"}
          </Button>
        )}
      </td>
      <td className="px-2 py-2 text-right text-sm tabular-nums whitespace-nowrap">
        {fmt(item.quantity, 2)} {item.unit ?? "ks"}
      </td>
      {/* Unit price — click-to-edit */}
      <td className="px-2 py-2 text-right text-sm tabular-nums whitespace-nowrap">
        <InlineEdit
          value={item.unitPriceWithoutVat.toFixed(2)}
          type="number"
          onSave={onEditPrice}
          className="justify-end"
        />
      </td>
      <td className="px-2 py-2 text-right text-sm tabular-nums whitespace-nowrap text-muted-foreground">
        {item.previousPrice != null ? `${fmt(item.previousPrice)} Kč` : "–"}
      </td>
      <td
        className={`px-2 py-2 text-right text-sm tabular-nums whitespace-nowrap ${pctColor(item.priceChangePercent)}`}
      >
        {fmtPct(item.priceChangePercent)}
      </td>
      <td className="px-2 py-2 text-right text-sm tabular-nums">
        {item.confidence != null ? (
          <span
            className={
              item.confidence < 0.7
                ? "text-violet-600 dark:text-violet-400 font-medium"
                : "text-muted-foreground"
            }
          >
            {Math.round(item.confidence * 100)} %
          </span>
        ) : (
          "–"
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1 justify-end flex-wrap">
          {item.matchConfirmed ? (
            <>
              {isSkipped ? (
                <span className="text-xs text-muted-foreground italic">Přeskočeno</span>
              ) : (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Potvrzeno
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={onReturn}
                disabled={returning}
                title="Vrátit k opravě"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={onConfirm}
                disabled={confirming}
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Potvrdit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={onSkip}
                disabled={skipping}
                title="Přeskočit"
              >
                <SkipForward className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpen}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Document group card
// ---------------------------------------------------------------------------

function DocGroupCard({
  group,
  selectedLines,
  onToggleLine,
  onConfirmLine,
  onAssignSuggestedJob,
  onOpenJobPicker,
  onOpenWarehousePicker,
  onSkipLine,
  onReturnLine,
  onEditDescription,
  onEditPrice,
  confirmingLine,
  assigningJobLine,
  skippingLine,
  returningLine,
  warehouseAssigningLine,
  onOpenDoc,
}: {
  group: DocGroup;
  selectedLines: Set<number>;
  onToggleLine: (id: number) => void;
  onConfirmLine: (id: number) => void;
  onAssignSuggestedJob: (item: ReviewQueueItem) => void;
  onOpenJobPicker: (item: ReviewQueueItem) => void;
  onOpenWarehousePicker: (item: ReviewQueueItem) => void;
  onSkipLine: (id: number) => void;
  onReturnLine: (id: number) => void;
  onEditDescription: (documentId: number, lineId: number, v: string) => Promise<void>;
  onEditPrice: (documentId: number, lineId: number, v: string) => Promise<void>;
  confirmingLine: number | null;
  assigningJobLine: number | null;
  skippingLine: number | null;
  returningLine: number | null;
  warehouseAssigningLine: number | null;
  onOpenDoc: (id: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { doc, items } = group;
  const unconfirmedCount = items.filter((i) => !i.matchConfirmed).length;

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden mb-3">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-tight">
              {doc.supplierName ?? "Neznámý dodavatel"}
              {doc.documentNumber && (
                <span className="ml-2 text-muted-foreground font-normal">
                  #{doc.documentNumber}
                </span>
              )}
              {doc.variableSymbol && (
                <span className="ml-2 text-muted-foreground font-normal text-xs">
                  VS: {doc.variableSymbol}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {doc.issueDate ? new Date(doc.issueDate).toLocaleDateString("cs-CZ") : ""}
              {" · "}
              {items.length}{" "}
              {items.length === 1 ? "řádek" : items.length < 5 ? "řádky" : "řádků"}
              {unconfirmedCount > 0 && (
                <span className="ml-2 text-orange-600 dark:text-orange-400 font-medium">
                  · {unconfirmedCount} nepotvrzeno
                </span>
              )}
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 ml-2 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDoc(doc.id);
          }}
        >
          <ExternalLink className="h-3.5 w-3.5 mr-1" />
          <span className="text-xs">Doklad</span>
        </Button>
      </button>

      {!collapsed && (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm min-w-[980px]">
            <thead>
              <tr className="bg-muted/50 text-xs text-muted-foreground">
                <th className="px-3 py-1.5 w-8" />
                <th className="px-2 py-1.5 text-left font-medium">Popis</th>
                <th className="px-2 py-1.5 text-left font-medium">Sklad. karta</th>
                <th className="px-2 py-1.5 text-left font-medium">Zakázka</th>
                <th className="px-2 py-1.5 text-right font-medium">Množství</th>
                <th className="px-2 py-1.5 text-right font-medium">Nák. cena</th>
                <th className="px-2 py-1.5 text-right font-medium">Sklad. cena</th>
                <th className="px-2 py-1.5 text-right font-medium">Δ%</th>
                <th className="px-2 py-1.5 text-right font-medium">Jistota</th>
                <th className="px-2 py-1.5 text-right font-medium">Akce</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <LineRow
                  key={item.lineId}
                  item={item}
                  selected={selectedLines.has(item.lineId)}
                  onToggle={() => onToggleLine(item.lineId)}
                  onConfirm={() => onConfirmLine(item.lineId)}
                  onAssignSuggestedJob={() => onAssignSuggestedJob(item)}
                  onOpenJobPicker={() => onOpenJobPicker(item)}
                  onOpenWarehousePicker={() => onOpenWarehousePicker(item)}
                  onSkip={() => onSkipLine(item.lineId)}
                  onReturn={() => onReturnLine(item.lineId)}
                  onEditDescription={(v) => onEditDescription(item.documentId, item.lineId, v)}
                  onEditPrice={(v) => onEditPrice(item.documentId, item.lineId, v)}
                  confirming={confirmingLine === item.lineId}
                  assigningJob={assigningJobLine === item.lineId}
                  skipping={skippingLine === item.lineId}
                  returning={returningLine === item.lineId}
                  warehouseAssigning={warehouseAssigningLine === item.lineId}
                  onOpen={() => onOpenDoc(doc.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

export default function BillingReviewQueue() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [reason, setReason] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());

  // Confirm bulk
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [diffResult, setDiffResult] = useState<BulkReviewDiff | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  // Skip dialog
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);
  const [skipTarget, setSkipTarget] = useState<number | null>(null);
  const [skippingBulk, setSkippingBulk] = useState(false);

  // Warehouse picker
  const [warehouseTarget, setWarehouseTarget] = useState<ReviewQueueItem | null>(null);
  const [warehouseAssigningLine, setWarehouseAssigningLine] = useState<number | null>(null);

  // Job picker
  const [jobPickerTarget, setJobPickerTarget] = useState<ReviewQueueItem | null>(null);
  const [assigningJobLine, setAssigningJobLine] = useState<number | null>(null);

  // Per-line loading states
  const [confirmingLine, setConfirmingLine] = useState<number | null>(null);
  const [skippingLine, setSkippingLine] = useState<number | null>(null);
  const [returningLine, setReturningLine] = useState<number | null>(null);

  const queryReason =
    reason === "all"
      ? undefined
      : (reason as typeof ListBillingReviewQueueReason[keyof typeof ListBillingReviewQueueReason]);

  const queryParams = {
    page,
    pageSize: PAGE_SIZE,
    ...(queryReason ? { reason: queryReason } : {}),
  };

  const { data, isLoading } = useListBillingReviewQueue(queryParams, {
    query: { queryKey: getListBillingReviewQueueQueryKey(queryParams) },
  });

  const { mutateAsync: bulkConfirm } = useBulkConfirmReviewLines();
  const { mutateAsync: skipLines } = useSkipReviewLines();
  const { mutateAsync: returnLines } = useReturnReviewLines();
  const { mutateAsync: updateLine } = useUpdateCostDocumentLine();
  const { mutateAsync: assignWarehouse } = useAssignWarehouseItemToReviewLine();
  const { mutateAsync: createWarehouseItem } = useCreateWarehouseItem();

  const groups = useMemo(() => groupByDocument(data?.items ?? []), [data?.items]);

  const allUnconfirmedIds = useMemo(
    () => (data?.items ?? []).filter((i) => !i.matchConfirmed).map((i) => i.lineId),
    [data?.items],
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  async function invalidateQueue() {
    await invalidateData(qc, "reviewQueue", "billingDocuments");
  }

  function toggleLine(id: number) {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedLines.size === allUnconfirmedIds.length) {
      setSelectedLines(new Set());
    } else {
      setSelectedLines(new Set(allUnconfirmedIds));
    }
  }

  // --- Confirm single line ---
  async function handleConfirmLine(lineId: number) {
    setConfirmingLine(lineId);
    try {
      await bulkConfirm({ data: { lineIds: [lineId], dryRun: false } });
      await invalidateQueue();
      toast({ title: "Řádek potvrzen." });
      setSelectedLines((prev) => { const next = new Set(prev); next.delete(lineId); return next; });
    } catch {
      toast({ title: "Chyba při potvrzování řádku.", variant: "destructive" });
    } finally {
      setConfirmingLine(null);
    }
  }

  // --- Assign suggested job ---
  async function handleAssignSuggestedJob(item: ReviewQueueItem) {
    if (!item.suggestedJobId) return;
    setAssigningJobLine(item.lineId);
    try {
      await updateLine({ id: item.documentId, lineId: item.lineId, data: { jobId: item.suggestedJobId, matchConfirmed: true } });
      await invalidateQueue();
      toast({ title: `Zakázka #${item.suggestedJobId} přiřazena.` });
    } catch {
      toast({ title: "Přiřazení zakázky selhalo.", variant: "destructive" });
    } finally {
      setAssigningJobLine(null);
    }
  }

  // --- Arbitrary job assignment from picker ---
  async function handleJobPickerAssign(jobId: number | null) {
    if (!jobPickerTarget) return;
    setAssigningJobLine(jobPickerTarget.lineId);
    try {
      await updateLine({
        id: jobPickerTarget.documentId,
        lineId: jobPickerTarget.lineId,
        data: { jobId: jobId ?? null },
      });
      await invalidateQueue();
      toast({ title: jobId ? `Zakázka #${jobId} přiřazena.` : "Zakázka odebrána." });
    } catch {
      toast({ title: "Přiřazení zakázky selhalo.", variant: "destructive" });
    } finally {
      setAssigningJobLine(null);
      setJobPickerTarget(null);
    }
  }

  // --- Warehouse picker: assign existing ---
  async function handleWarehouseAssign(warehouseItemId: number) {
    if (!warehouseTarget) return;
    setWarehouseAssigningLine(warehouseTarget.lineId);
    try {
      await assignWarehouse({ lineId: warehouseTarget.lineId, data: { warehouseItemId } });
      await invalidateQueue();
      toast({ title: "Skladová karta přiřazena." });
    } catch {
      toast({ title: "Přiřazení skladu selhalo.", variant: "destructive" });
    } finally {
      setWarehouseAssigningLine(null);
      setWarehouseTarget(null);
    }
  }

  // --- Warehouse picker: create new then assign ---
  async function handleWarehouseCreate(name: string) {
    if (!warehouseTarget) return;
    setWarehouseAssigningLine(warehouseTarget.lineId);
    try {
      const newItem = await createWarehouseItem({ data: { name } });
      await assignWarehouse({ lineId: warehouseTarget.lineId, data: { warehouseItemId: newItem.id } });
      await invalidateQueue();
      toast({ title: `Karta "${name}" vytvořena a přiřazena.` });
    } catch {
      toast({ title: "Vytvoření nebo přiřazení karty selhalo.", variant: "destructive" });
    } finally {
      setWarehouseAssigningLine(null);
      setWarehouseTarget(null);
    }
  }

  // --- Inline edit description ---
  async function handleEditDescription(documentId: number, lineId: number, v: string) {
    try {
      await updateLine({ id: documentId, lineId, data: { description: v } });
      await invalidateQueue();
      toast({ title: "Popis aktualizován." });
    } catch {
      toast({ title: "Uložení popisu selhalo.", variant: "destructive" });
      throw new Error("save failed");
    }
  }

  // --- Inline edit price ---
  async function handleEditPrice(documentId: number, lineId: number, v: string) {
    const price = parseFloat(v);
    if (isNaN(price) || price < 0) {
      toast({ title: "Neplatná cena.", variant: "destructive" });
      throw new Error("invalid");
    }
    try {
      await updateLine({ id: documentId, lineId, data: { unitPriceWithoutVat: price } });
      await invalidateQueue();
      toast({ title: "Cena aktualizována." });
    } catch {
      toast({ title: "Uložení ceny selhalo.", variant: "destructive" });
      throw new Error("save failed");
    }
  }

  // --- Bulk preview before confirm ---
  async function handleBulkPreview() {
    const ids = [...selectedLines];
    if (ids.length === 0) return;
    try {
      const diff = await bulkConfirm({ data: { lineIds: ids, dryRun: true } });
      setDiffResult(diff);
      setConfirmDialogOpen(true);
    } catch {
      toast({ title: "Chyba při přípravě potvrzení.", variant: "destructive" });
    }
  }

  async function handleBulkConfirm() {
    const ids = [...selectedLines];
    setConfirmingBulk(true);
    try {
      const result = await bulkConfirm({ data: { lineIds: ids, dryRun: false } });
      setConfirmDialogOpen(false);
      setSelectedLines(new Set());
      await invalidateQueue();
      toast({ title: `Potvrzeno ${result.toConfirm} řádků.` });
    } catch {
      toast({ title: "Hromadné potvrzení selhalo.", variant: "destructive" });
    } finally {
      setConfirmingBulk(false);
    }
  }

  // --- Skip single line ---
  function handleSkipLine(lineId: number) {
    setSkipTarget(lineId);
    setSkipDialogOpen(true);
  }

  // --- Skip bulk ---
  function handleSkipBulk() {
    setSkipTarget(null);
    setSkipDialogOpen(true);
  }

  async function handleSkipConfirm(skipReason: string) {
    const ids = skipTarget != null ? [skipTarget] : [...selectedLines];
    if (ids.length === 0) { setSkipDialogOpen(false); return; }

    if (skipTarget != null) setSkippingLine(skipTarget);
    else setSkippingBulk(true);

    try {
      const result = await skipLines({ data: { lineIds: ids, reason: skipReason } });
      setSkipDialogOpen(false);
      if (skipTarget == null) setSelectedLines(new Set());
      await invalidateQueue();
      toast({ title: `Přeskočeno ${result.skipped} řádků.` });
    } catch {
      toast({ title: "Přeskočení selhalo.", variant: "destructive" });
    } finally {
      setSkippingLine(null);
      setSkippingBulk(false);
      setSkipTarget(null);
    }
  }

  // --- Return single line ---
  async function handleReturnLine(lineId: number) {
    setReturningLine(lineId);
    try {
      await returnLines({ data: { lineIds: [lineId] } });
      await invalidateQueue();
      toast({ title: "Řádek vrácen k opravě." });
    } catch {
      toast({ title: "Vrácení selhalo.", variant: "destructive" });
    } finally {
      setReturningLine(null);
    }
  }

  const hasSelection = selectedLines.size > 0;
  const allSelected =
    allUnconfirmedIds.length > 0 && selectedLines.size === allUnconfirmedIds.length;

  const skipCount = skipTarget != null ? 1 : selectedLines.size;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => setLocation("/billing")}
        >
          <ArrowLeft className="h-4 w-4" />
          Fakturace
        </Button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-lg font-semibold">K vyřízení</h1>
        {data && (
          <Badge variant="secondary" className="ml-1">
            {data.total}
          </Badge>
        )}
      </div>

      {/* Filter + bulk action bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select
          value={reason}
          onValueChange={(v) => { setReason(v); setPage(1); setSelectedLines(new Set()); }}
        >
          <SelectTrigger className="w-52 h-8">
            <SelectValue placeholder="Filtr důvodu" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Všechny důvody</SelectItem>
            <SelectItem value="needs_review">Ke kontrole</SelectItem>
            <SelectItem value="low_confidence">Nízká jistota AI</SelectItem>
            <SelectItem value="missing_job">Chybí zakázka</SelectItem>
            <SelectItem value="missing_warehouse_item">Chybí karta skladu</SelectItem>
            <SelectItem value="price_jump">Skok ceny</SelectItem>
          </SelectContent>
        </Select>

        {allUnconfirmedIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={toggleAll}
          >
            {allSelected ? <SquareCheck className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            {allSelected ? "Odznačit vše" : `Vybrat vše (${allUnconfirmedIds.length})`}
          </Button>
        )}

        {hasSelection && (
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-muted-foreground"
              onClick={handleSkipBulk}
              disabled={skippingBulk}
            >
              <SkipForward className="h-4 w-4" />
              Přeskočit ({selectedLines.size})
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={handleBulkPreview}>
              <CheckCircle2 className="h-4 w-4" />
              Potvrdit ({selectedLines.size})
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium">Fronta je prázdná</p>
          <p className="text-xs mt-1">Žádné řádky dokladů nevyžadují pozornost.</p>
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <DocGroupCard
              key={group.doc.id}
              group={group}
              selectedLines={selectedLines}
              onToggleLine={toggleLine}
              onConfirmLine={handleConfirmLine}
              onAssignSuggestedJob={handleAssignSuggestedJob}
              onOpenJobPicker={(item) => setJobPickerTarget(item)}
              onOpenWarehousePicker={(item) => setWarehouseTarget(item)}
              onSkipLine={handleSkipLine}
              onReturnLine={handleReturnLine}
              onEditDescription={handleEditDescription}
              onEditPrice={handleEditPrice}
              confirmingLine={confirmingLine}
              assigningJobLine={assigningJobLine}
              skippingLine={skippingLine}
              returningLine={returningLine}
              warehouseAssigningLine={warehouseAssigningLine}
              onOpenDoc={(id) => setLocation(`/billing/documents/${id}`)}
            />
          ))}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-muted-foreground">
                Strana {page} z {totalPages} · celkem {data?.total ?? 0} řádků
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Předchozí
                </Button>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Další
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDiffDialog
        diff={diffResult}
        open={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
        onConfirm={handleBulkConfirm}
        confirming={confirmingBulk}
      />

      <SkipDialog
        open={skipDialogOpen}
        count={skipCount}
        onClose={() => { setSkipDialogOpen(false); setSkipTarget(null); }}
        onSkip={(r) => void handleSkipConfirm(r)}
        skipping={skippingBulk || skippingLine != null}
      />

      <WarehousePickerDialog
        open={warehouseTarget != null}
        onClose={() => setWarehouseTarget(null)}
        lineDescription={warehouseTarget?.description ?? ""}
        onAssign={handleWarehouseAssign}
        onCreate={handleWarehouseCreate}
        busy={warehouseAssigningLine != null}
      />

      <JobPickerDialog
        open={jobPickerTarget != null}
        onClose={() => setJobPickerTarget(null)}
        currentJobId={jobPickerTarget?.jobId}
        onAssign={handleJobPickerAssign}
        busy={assigningJobLine != null}
      />
    </div>
  );
}
