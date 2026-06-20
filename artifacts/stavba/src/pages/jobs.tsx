import { useState, useEffect, useCallback } from "react";
import { useSearch } from "wouter";
import {
  useListJobs,
  getListJobsQueryKey,
  useGetMyPreferences,
  useUpdateMyPreferences,
  getGetMyPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { JobCard } from "@/components/job-card";
import { sortJobsDoneLast } from "@/lib/job-sort";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Download, Calendar, Save, Pencil, Trash2 } from "lucide-react";
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

const EXPORT_COLUMNS_STORAGE_KEY = "stavba.exportColumns.v1";

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

export default function Jobs() {
  const search_ = useSearch();
  const [status, setStatus] = useState<string>(() => readStatusFromSearch(search_));

  useEffect(() => {
    setStatus(readStatusFromSearch(search_));
  }, [search_]);

  const [search, setSearch] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [groupByCustomer, setGroupByCustomer] = useState(true);
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [selectedColumns, setSelectedColumns] = useState<ExportColumnKey[]>(
    loadStoredColumns
  );
  const [isHydrated, setIsHydrated] = useState(false);
  const [presets, setPresets] = useState<ExportPreset[]>(() => loadPresets());
  const [activePresetId, setActivePresetId] = useState<string>("");

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
      const ok = window.confirm(`Předvolba "${trimmed}" už existuje. Přepsat?`);
      if (!ok) return;
      const next = presets.map(p =>
        p.id === existing.id ? { ...p, columns: [...orderedSelected] } : p
      );
      persistPresets(next);
      setActivePresetId(existing.id);
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
    const ok = window.confirm(`Smazat předvolbu "${preset.name}"?`);
    if (!ok) return;
    persistPresets(presets.filter(p => p.id !== preset.id));
    setActivePresetId("");
  }

  const { data: serverPrefs, isFetched: serverPrefsFetched } = useGetMyPreferences({
    query: {
      queryKey: getGetMyPreferencesQueryKey(),
      enabled: isAuthenticated,
      staleTime: 60_000,
      retry: false,
    },
  });

  // One-time hydration: if authenticated, prefer server value; otherwise mark
  // local state as authoritative immediately.
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

  // Persist user-driven changes. Local storage is always written; server is
  // updated only when authenticated and hydration has completed, so the
  // initial server snapshot is never overwritten by stale local state.
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

  const { data: jobs, isLoading } = useListJobs(
    status !== "all" ? { status } : {},
    { query: { queryKey: getListJobsQueryKey(status !== "all" ? { status } : {}) } }
  );

  const filtered = jobs?.filter(j =>
    j.title.toLowerCase().includes(search.toLowerCase()) ||
    (j.clientSite || "").toLowerCase().includes(search.toLowerCase()) ||
    (j.customerCompanyName || "").toLowerCase().includes(search.toLowerCase())
  );

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

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Všechny zakázky</h1>
        <Button variant="outline" size="sm" onClick={() => setExportOpen(true)} className="gap-2">
          <Download className="h-4 w-4" />
          Export
        </Button>
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
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px] h-12">
            <SelectValue placeholder="Stav" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Vše</SelectItem>
            {Object.entries(JOB_STATUSES).map(([key, config]) => (
              <SelectItem key={key} value={key}>{config.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)
        ) : filtered && filtered.length > 0 ? (
          sortJobsDoneLast(filtered, { newestFirst: true }).map(job => <JobCard key={job.id} job={job} />)
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <p>Žádné zakázky odpovídající vašemu hledání.</p>
          </div>
        )}
      </div>

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
    </div>
  );
}
