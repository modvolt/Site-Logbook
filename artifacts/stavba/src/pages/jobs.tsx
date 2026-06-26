import { useState, useEffect, useCallback } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useSearch, useLocation } from "wouter";
import {
  useListJobs,
  getListJobsQueryKey,
  useGetMyPreferences,
  useUpdateMyPreferences,
  getGetMyPreferencesQueryKey,
  useBulkUpdateJobStatus,
  useGetWarehouseJobsMarginSummary,
} from "@workspace/api-client-react";
import type { ListJobsParams } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { JobCard } from "@/components/job-card";
import { sortJobsDoneLast } from "@/lib/job-sort";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Download, Calendar, Save, Pencil, Trash2, X, CheckSquare, Square, AlertCircle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_STATUSES } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  exportJobsToXlsx,
  exportJobsToPdf,
  EXPORT_COLUMNS,
  DEFAULT_EXPORT_COLUMNS,
  type ExportColumnKey,
} from "@/lib/export-jobs";
import { loadCompanySettings } from "@/lib/company-settings";
import { BRAND_NAME, getBrandLogoDataUrl } from "@/lib/brand";
import {
  loadPresets,
  savePresets,
  createPresetId,
  type ExportPreset,
} from "@/lib/export-presets";
import { invalidateData } from "@/lib/query-invalidation";
import { toast } from "sonner";

const EXPORT_COLUMNS_STORAGE_KEY = "stavba.exportColumns.v1";

type Segment = "in_progress" | "ready_to_bill" | "problematic" | "without_customer" | "without_price" | "cancelled";

const SEGMENTS: { key: Segment; label: string; className: string }[] = [
  { key: "in_progress", label: "Rozpracované", className: "border-amber-400 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100" },
  { key: "ready_to_bill", label: "K fakturaci", className: "border-green-500 text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 hover:bg-green-100" },
  { key: "problematic", label: "Problémové", className: "border-red-400 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 hover:bg-red-100" },
  { key: "without_customer", label: "Bez zákazníka", className: "border-orange-400 text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100" },
  { key: "without_price", label: "Bez ceny", className: "border-violet-400 text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-900/20 hover:bg-violet-100" },
  { key: "cancelled", label: "Archiv", className: "border-gray-400 text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 hover:bg-gray-100" },
];

function sanitizeColumns(raw: unknown): ExportColumnKey[] | null {
  if (!Array.isArray(raw)) return null;
  const valid = new Set(DEFAULT_EXPORT_COLUMNS);
  const filtered = raw.filter((k): k is ExportColumnKey =>
    typeof k === "string" && valid.has(k as ExportColumnKey)
  );
  return filtered.length > 0 ? filtered : null;
}

function loadStoredColumns(): ExportColumnKey[] {
  if (typeof window === "undefined") return DEFAULT_EXPORT_COLUMNS;
  try {
    const raw = window.localStorage.getItem(EXPORT_COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_EXPORT_COLUMNS;
    return sanitizeColumns(JSON.parse(raw)) ?? DEFAULT_EXPORT_COLUMNS;
  } catch {
    return DEFAULT_EXPORT_COLUMNS;
  }
}

function readStatusFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("status");
  if (value && value in JOB_STATUSES) return value;
  return "all";
}

function readSegmentFromSearch(search: string): Segment | null {
  const value = new URLSearchParams(search).get("segment");
  if (value && SEGMENTS.some(s => s.key === value)) return value as Segment;
  return null;
}

function buildJobsSearch(opts: { status: string; segment: Segment | null }): string {
  const params = new URLSearchParams();
  if (opts.segment) {
    params.set("segment", opts.segment);
  } else if (opts.status !== "all") {
    params.set("status", opts.status);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function readTextFromSearch(search: string): string {
  return new URLSearchParams(search).get("search") ?? "";
}

export default function Jobs() {
  const search_ = useSearch();
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<string>(() => {
    const seg = readSegmentFromSearch(search_);
    return seg ? "all" : readStatusFromSearch(search_);
  });
  const [segment, setSegment] = useState<Segment | null>(() => readSegmentFromSearch(search_));

  useEffect(() => {
    const seg = readSegmentFromSearch(search_);
    if (seg) {
      setSegment(seg);
      setStatus("all");
    } else {
      setSegment(null);
      setStatus(readStatusFromSearch(search_));
    }
  }, [search_]);

  const [search, setSearch] = useState(() => readTextFromSearch(search_));
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [groupByCustomer, setGroupByCustomer] = useState(true);
  const { isAuthenticated, can } = useAuth();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const queryClient = useQueryClient();
  const [selectedColumns, setSelectedColumns] = useState<ExportColumnKey[]>(
    loadStoredColumns
  );
  const [isHydrated, setIsHydrated] = useState(false);
  const [presets, setPresets] = useState<ExportPreset[]>(() => loadPresets());
  const [activePresetId, setActivePresetId] = useState<string>("");

  // Bulk selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<string>("");

  const { mutate: bulkUpdateStatus, isPending: isBulkUpdating } = useBulkUpdateJobStatus();

  function toggleSelectMode() {
    setSelectMode(prev => !prev);
    setSelectedIds(new Set());
    setBulkStatus("");
  }

  function handleSelect(id: number, checked: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleSelectAll() {
    const visibleIds = sortedFiltered?.map(j => j.id) ?? [];
    setSelectedIds(new Set(visibleIds));
  }

  function handleDeselectAll() {
    setSelectedIds(new Set());
  }

  function handleBulkApply() {
    if (selectedIds.size === 0 || !bulkStatus) return;
    bulkUpdateStatus(
      { data: { ids: Array.from(selectedIds), status: bulkStatus } },
      {
        onSuccess: (result) => {
          toast.success(`Stav zakázek aktualizován (${result.updated} zakázek).`);
          setSelectedIds(new Set());
          setSelectMode(false);
          setBulkStatus("");
          invalidateData(queryClient, "jobs");
        },
        onError: () => {
          toast.error("Nepodařilo se aktualizovat stav zakázek.");
        },
      }
    );
  }

  function persistPresets(next: ExportPreset[]) {
    setPresets(next);
    savePresets(next);
  }

  function handleApplyPreset(id: string) {
    setActivePresetId(id);
    const preset = presets.find(p => p.id === id);
    if (!preset) return;
    persistColumns(DEFAULT_EXPORT_COLUMNS.filter(k => preset.columns.includes(k)));
  }

  function handleSavePreset() {
    const name = window.prompt("Název předvolby:");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = presets.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      openConfirm({ title: `Předvolba "${trimmed}" už existuje.`, confirmLabel: "Přepsat", destructive: false }, () => {
        const next = presets.map(p =>
          p.id === existing.id ? { ...p, columns: [...orderedSelected] } : p
        );
        persistPresets(next);
        setActivePresetId(existing.id);
      });
      return;
    }
    const preset: ExportPreset = {
      id: createPresetId(),
      name: trimmed,
      columns: [...orderedSelected],
    };
    persistPresets([...presets, preset]);
    setActivePresetId(preset.id);
  }

  function handleRenamePreset() {
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset) return;
    const name = window.prompt("Přejmenovat předvolbu:", preset.name);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === preset.name) return;
    const next = presets.map(p =>
      p.id === preset.id ? { ...p, name: trimmed } : p
    );
    persistPresets(next);
  }

  function handleDeletePreset() {
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset) return;
    openConfirm(`Smazat předvolbu "${preset.name}"?`, () => {
      persistPresets(presets.filter(p => p.id !== preset.id));
      setActivePresetId("");
    });
  }

  const { data: serverPrefs, isFetched: serverPrefsFetched } = useGetMyPreferences({
    query: {
      queryKey: getGetMyPreferencesQueryKey(),
      enabled: isAuthenticated,
      staleTime: 60_000,
      retry: false,
    },
  });

  useEffect(() => {
    if (isHydrated) return;
    if (!isAuthenticated) {
      setIsHydrated(true);
      return;
    }
    if (!serverPrefsFetched) return;
    const fromServer = sanitizeColumns(serverPrefs?.exportColumns);
    if (fromServer) setSelectedColumns(fromServer);
    setIsHydrated(true);
  }, [isAuthenticated, serverPrefs, serverPrefsFetched, isHydrated]);

  const { mutate: saveServerPrefs } = useUpdateMyPreferences();

  const persistColumns = useCallback(
    (next: ExportColumnKey[]) => {
      setSelectedColumns(next);
      try {
        window.localStorage.setItem(
          EXPORT_COLUMNS_STORAGE_KEY,
          JSON.stringify(next)
        );
      } catch {
        // ignore quota/availability errors
      }
      if (isAuthenticated && isHydrated) {
        saveServerPrefs(
          { data: { exportColumns: next } },
          {
            onSuccess: () => {
              queryClient.setQueryData(getGetMyPreferencesQueryKey(), {
                exportColumns: next,
              });
            },
          }
        );
      }
    },
    [isAuthenticated, isHydrated, saveServerPrefs, queryClient]
  );

  const queryParams: ListJobsParams = segment
    ? { segment }
    : status !== "all"
    ? { status }
    : {};

  const { data: jobs, isLoading, isError } = useListJobs(
    queryParams,
    { query: { queryKey: getListJobsQueryKey(queryParams) } }
  );

  const filtered = jobs?.filter(j =>
    j.title.toLowerCase().includes(search.toLowerCase()) ||
    (j.clientSite || "").toLowerCase().includes(search.toLowerCase()) ||
    (j.customerCompanyName || "").toLowerCase().includes(search.toLowerCase()) ||
    ((j as any).shortName || "").toLowerCase().includes(search.toLowerCase())
  );

  const sortedFiltered = filtered ? sortJobsDoneLast(filtered, { newestFirst: true }) : undefined;

  const { data: jobMargins } = useGetWarehouseJobsMarginSummary();
  const marginByJobId = new Map<number, number | null>(
    (jobMargins?.items ?? []).map((m) => [m.jobId, m.marginPercent ?? null])
  );
  const marginThreshold = jobMargins?.alertThresholdPercent ?? 0;

  const { data: exportJobs } = useListJobs(
    {
      ...(exportFrom ? { from: exportFrom } : {}),
      ...(exportTo ? { to: exportTo } : {}),
    },
    {
      query: {
        queryKey: getListJobsQueryKey({
          ...(exportFrom ? { from: exportFrom } : {}),
          ...(exportTo ? { to: exportTo } : {}),
        }),
        enabled: exportOpen,
      },
    }
  );

  const orderedSelected = DEFAULT_EXPORT_COLUMNS.filter(k =>
    selectedColumns.includes(k)
  );
  const hasColumns = orderedSelected.length > 0;

  function toggleColumn(key: ExportColumnKey, checked: boolean) {
    const set = new Set(selectedColumns);
    if (checked) set.add(key);
    else set.delete(key);
    persistColumns(DEFAULT_EXPORT_COLUMNS.filter(k => set.has(k)));
  }

  function selectAllColumns() {
    persistColumns([...DEFAULT_EXPORT_COLUMNS]);
  }

  function clearAllColumns() {
    persistColumns([]);
  }

  function handleExport() {
    setExporting(true);
    try {
      const data = exportJobs ?? [];
      const fromLabel = exportFrom || "začátek";
      const toLabel = exportTo || "konec";
      exportJobsToXlsx(
        data,
        `zakázky-${fromLabel}–${toLabel}.xlsx`,
        orderedSelected
      );
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }

  async function handleExportPdf() {
    setExporting(true);
    try {
      const data = exportJobs ?? [];
      const fromLabel = exportFrom || "začátek";
      const toLabel = exportTo || "konec";
      const company = loadCompanySettings();
      let logoDataUrl = company.logoDataUrl;
      if (!logoDataUrl) {
        try {
          logoDataUrl = await getBrandLogoDataUrl();
        } catch {
          logoDataUrl = "";
        }
      }
      await exportJobsToPdf(data, {
        from: exportFrom || undefined,
        to: exportTo || undefined,
        filename: `zakázky-${fromLabel}–${toLabel}.pdf`,
        columnKeys: orderedSelected,
        groupByCustomer,
        companyName: company.name || BRAND_NAME,
        companyLogoDataUrl: logoDataUrl,
      });
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }

  function handleSegmentClick(key: Segment) {
    const next = segment === key ? null : key;
    setLocation(buildJobsSearch({ status: "all", segment: next }), { replace: true });
  }

  function handleStatusChange(value: string) {
    setLocation(buildJobsSearch({ status: value, segment: null }), { replace: true });
  }

  const activeSegmentConfig = segment ? SEGMENTS.find(s => s.key === segment) : null;
  const canWrite = can("write");
  const allVisibleSelected = (sortedFiltered?.length ?? 0) > 0 &&
    sortedFiltered?.every(j => selectedIds.has(j.id));

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full pb-28">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Všechny zakázky</h1>
        <div className="flex items-center gap-2">
          {canWrite && (
            <Button
              variant={selectMode ? "secondary" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
              className="gap-2"
            >
              {selectMode ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
              {selectMode ? "Zrušit výběr" : "Hromadně"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)} className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Segment chips */}
      <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar pb-1">
        {SEGMENTS.map(seg => (
          <button
            key={seg.key}
            type="button"
            onClick={() => handleSegmentClick(seg.key)}
            className={`shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
              segment === seg.key
                ? seg.className + " ring-2 ring-offset-1 ring-current"
                : "border-border text-muted-foreground bg-background hover:bg-muted"
            }`}
          >
            {seg.label}
            {segment === seg.key && (
              <X className="w-3 h-3 ml-0.5 opacity-70" />
            )}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Hledat zakázky..."
            className="pl-10 h-12 text-base"
          />
        </div>
        <Select value={segment ? "__segment" : status} onValueChange={v => { if (v !== "__segment") handleStatusChange(v); }}>
          <SelectTrigger className={`w-[150px] h-12 ${activeSegmentConfig ? activeSegmentConfig.className + " border" : ""}`}>
            <SelectValue>
              {activeSegmentConfig ? activeSegmentConfig.label : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Vše</SelectItem>
            {Object.entries(JOB_STATUSES).map(([key, config]) => (
              <SelectItem key={key} value={key}>{config.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Select all / deselect all bar */}
      {selectMode && sortedFiltered && sortedFiltered.length > 0 && (
        <div className="flex items-center gap-3 mb-3 px-1 text-sm text-muted-foreground">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={(v) => v ? handleSelectAll() : handleDeselectAll()}
            />
            <span>
              {selectedIds.size > 0
                ? `Vybráno ${selectedIds.size} z ${sortedFiltered.length}`
                : `Vybrat vše (${sortedFiltered.length})`}
            </span>
          </label>
          {selectedIds.size > 0 && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={handleDeselectAll}
            >
              Zrušit výběr
            </button>
          )}
        </div>
      )}

      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <AlertCircle className="h-10 w-10 opacity-30" />
            <p className="font-medium">Nepodařilo se načíst zakázky</p>
            <p className="text-sm">Zkontrolujte připojení nebo zkuste stránku obnovit.</p>
          </div>
        ) : sortedFiltered && sortedFiltered.length > 0 ? (
          sortedFiltered.map(job => (
            <JobCard
              key={job.id}
              job={job}
              selected={selectMode ? selectedIds.has(job.id) : undefined}
              onSelect={selectMode ? handleSelect : undefined}
              marginPercent={marginByJobId.get(job.id)}
              marginThreshold={marginThreshold}
            />
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <p>Žádné zakázky odpovídající vašemu hledání.</p>
          </div>
        )}
      </div>

      {/* Floating bulk action bar */}
      {selectMode && (
        <div className="fixed bottom-20 left-0 right-0 flex justify-center z-50 px-4 pointer-events-none">
          <div className="pointer-events-auto w-full max-w-lg bg-background border shadow-xl rounded-2xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">
                {selectedIds.size > 0
                  ? `${selectedIds.size} zakázek vybráno`
                  : "Vyberte zakázky kliknutím"}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={toggleSelectMode}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-2">
              <Select value={bulkStatus} onValueChange={setBulkStatus}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Nový stav…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(JOB_STATUSES).map(([key, config]) => (
                    <SelectItem key={key} value={key}>{config.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={handleBulkApply}
                disabled={selectedIds.size === 0 || !bulkStatus || isBulkUpdating}
                className="shrink-0"
              >
                {isBulkUpdating
                  ? "Ukládám…"
                  : `Použít${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Export zakázek
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Vyber rozsah dat pro export. Nech prázdné pro export všech zakázek.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="export-from">Od</Label>
                <Input
                  id="export-from"
                  type="date"
                  value={exportFrom}
                  onChange={e => setExportFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="export-to">Do</Label>
                <Input
                  id="export-to"
                  type="date"
                  value={exportTo}
                  onChange={e => setExportTo(e.target.value)}
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={groupByCustomer}
                onCheckedChange={(v) => setGroupByCustomer(v === true)}
              />
              <div className="space-y-0.5">
                <span className="text-sm font-medium leading-none">
                  Rozdělit podle zákazníků
                </span>
                <p className="text-xs text-muted-foreground">
                  V PDF seskupí zakázky podle zákazníka s mezisoučty.
                </p>
              </div>
            </label>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Předvolby</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={activePresetId || "__none"}
                  onValueChange={(v) => {
                    if (v === "__none") {
                      setActivePresetId("");
                    } else {
                      handleApplyPreset(v);
                    }
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Vybrat předvolbu…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— bez předvolby —</SelectItem>
                    {presets.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleSavePreset}
                  disabled={!hasColumns}
                  title="Uložit jako novou předvolbu"
                >
                  <Save className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleRenamePreset}
                  disabled={!activePresetId}
                  title="Přejmenovat předvolbu"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleDeletePreset}
                  disabled={!activePresetId}
                  title="Smazat předvolbu"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Sloupce v exportu</Label>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={selectAllColumns}
                    className="text-primary hover:underline"
                  >
                    Vybrat vše
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button
                    type="button"
                    onClick={clearAllColumns}
                    className="text-primary hover:underline"
                  >
                    Zrušit vše
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border p-3 max-h-48 overflow-y-auto">
                {EXPORT_COLUMNS.map(col => {
                  const checked = selectedColumns.includes(col.key);
                  const id = `export-col-${col.key}`;
                  return (
                    <div key={col.key} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(v) => toggleColumn(col.key, v === true)}
                      />
                      <Label
                        htmlFor={id}
                        className="text-sm font-normal cursor-pointer"
                      >
                        {col.label}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
              {exportJobs != null
                ? `${exportJobs.length} zakázek bude exportováno · ${orderedSelected.length} sloupců`
                : "Načítám…"}
            </div>
          </div>

          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Zrušit
            </Button>
            <Button
              variant="outline"
              onClick={handleExportPdf}
              disabled={exporting || exportJobs == null || !hasColumns}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exportuji…" : "Stáhnout PDF"}
            </Button>
            <Button
              onClick={handleExport}
              disabled={exporting || exportJobs == null || !hasColumns}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exportuji…" : "Stáhnout Excel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
