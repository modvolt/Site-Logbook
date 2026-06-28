import { useState } from "react";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, addWeeks, addMonths, addYears } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useGetStatsOverview,
  getGetStatsOverviewQueryKey,
  useGetRisksSummary,
  getGetRisksSummaryQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { type RiskMetricFilter } from "@workspace/api-client-react";
import {
  ArrowLeft,
  Printer,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Search,
  Loader2,
  Briefcase,
  Users,
  Package,
  Warehouse,
  Banknote,
  AlertTriangle,
  FileSearch,
  PackageMinus,
  UserX,
  Tag,
  FileMinus,
  Clock,
  Wrench,
  TrendingUp,
  ShieldOff,
  TrendingDown,
  Minus,
  ArrowRight,
  HardHat,
  ShoppingCart,
  Activity,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { QueryErrorState } from "@/components/query-error-state";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JOB_TYPES } from "@/components/badges";
import { useToast } from "@/hooks/use-toast";
import { renderJobSheetPdf } from "@/lib/job-sheet-pdf";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/lib/brand";
import { loadCompanySettings } from "@/lib/company-settings";
import { fmtKc as fmtKcBilling } from "@/lib/billing-format";
import { useAuth } from "@/hooks/use-auth";

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  #statistika-list, #statistika-list * { visibility: visible !important; }
  #statistika-list { position: absolute; left: 0; top: 0; width: 100%; margin: 0; box-shadow: none !important; }
  .no-print { display: none !important; }
}
`;

type Period = "week" | "month" | "year";

type ProfitCol = "name" | "quantityIssued" | "saleRevenue" | "purchaseCost" | "grossProfit" | "margin";
type SortDir = "asc" | "desc";

const PERIOD_LABELS: Record<Period, string> = {
  week: "Týden",
  month: "Měsíc",
  year: "Rok",
};

function fmtKc(n: number): string {
  return `${Math.round(n).toLocaleString("cs-CZ")} Kč`;
}

function fmtKcShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M Kč`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} k Kč`;
  }
  return fmtKc(n);
}

const SCREEN_TO_HREF: Record<string, string> = {
  jobs: "/jobs",
  "billing/documents": "/billing/documents",
  warehouse: "/sklad",
  billing: "/billing",
  machines: "/stroje",
};

function buildRiskUrl(filter: RiskMetricFilter): string {
  const base = SCREEN_TO_HREF[filter.screen] ?? `/${filter.screen}`;
  const params = filter.params && Object.keys(filter.params).length > 0
    ? `?${new URLSearchParams(filter.params).toString()}`
    : "";
  return `${base}${params}`;
}

function fmtHours(n: number): string {
  return `${n.toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} h`;
}

function typeLabel(type: string): string {
  return JOB_TYPES[type as keyof typeof JOB_TYPES]?.label ?? type;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getRange(period: Period, anchor: Date): { from: Date; to: Date } {
  switch (period) {
    case "week":
      return { from: startOfWeek(anchor, { weekStartsOn: 1 }), to: endOfWeek(anchor, { weekStartsOn: 1 }) };
    case "month":
      return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    case "year":
      return { from: startOfYear(anchor), to: endOfYear(anchor) };
  }
}

function rangeLabel(period: Period, from: Date, to: Date): string {
  switch (period) {
    case "week":
      return `${format(from, "d. M.")} – ${format(to, "d. M. yyyy")}`;
    case "month":
      return capitalize(format(from, "LLLL yyyy", { locale: cs }));
    case "year":
      return format(from, "yyyy");
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return format(d, "LLL", { locale: cs });
}

// KPI delta helpers
function delta(current: number, previous: number): { pct: number | null; isNew: boolean } {
  if (previous === 0) return { pct: null, isNew: current > 0 };
  return { pct: ((current - previous) / previous) * 100, isNew: false };
}

type DeltaInfo = { pct: number | null; isNew: boolean };

function DeltaBadge({ info }: { info: DeltaInfo }) {
  if (info.isNew) {
    return <span className="inline-flex items-center gap-0.5 text-xs font-medium text-blue-600">nově v období</span>;
  }
  if (info.pct === null) return null;
  const up = info.pct >= 0;
  const Icon = info.pct === 0 ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? "text-emerald-600" : "text-red-500"}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(info.pct).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} %
    </span>
  );
}

type KpiCardProps = {
  label: string;
  value: string;
  sub?: string;
  delta?: DeltaInfo;
  href?: string;
  urgent?: boolean;
  icon?: React.ReactNode;
};

function KpiCard({ label, value, sub, delta: d, href, urgent, icon }: KpiCardProps) {
  const inner = (
    <div
      className={`rounded-xl border bg-card p-4 flex flex-col gap-1 transition-colors ${href ? "hover:bg-accent/50 cursor-pointer" : ""} ${urgent ? "border-red-300 bg-red-50 dark:bg-red-950/30" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground leading-tight">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className={`text-2xl font-bold tracking-tight leading-none ${urgent ? "text-red-600 dark:text-red-400" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      {d && <DeltaBadge info={d} />}
    </div>
  );
  if (href) return <Link href={href}>{inner}</Link>;
  return inner;
}

export default function Statistika() {
  const [period, setPeriodRaw] = useState<Period>(() => {
    try {
      const saved = localStorage.getItem("statistika.period");
      if (saved === "week" || saved === "month" || saved === "year") return saved;
    } catch {
    }
    return "month";
  });
  const setPeriod = (next: Period) => {
    try { localStorage.setItem("statistika.period", next); } catch { }
    setPeriodRaw(next);
  };
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [exporting, setExporting] = useState(false);
  const [company] = useState(() => loadCompanySettings());
  const { toast } = useToast();
  const { role, isLoading: authLoading } = useAuth();
  const isAdmin = role === "admin";

  const [profitSort, setProfitSortRaw] = useState<{ col: ProfitCol; dir: SortDir }>(() => {
    try {
      const saved = localStorage.getItem("statistika.profitSort");
      if (saved) {
        const parsed = JSON.parse(saved) as { col: ProfitCol; dir: SortDir };
        if (parsed.col && parsed.dir) return parsed;
      }
    } catch {
    }
    return { col: "grossProfit", dir: "desc" };
  });

  const setProfitSort = (next: { col: ProfitCol; dir: SortDir }) => {
    try { localStorage.setItem("statistika.profitSort", JSON.stringify(next)); } catch { }
    setProfitSortRaw(next);
  };

  const [profitFilter, setProfitFilter] = useState("");
  const [trendCustomerId, setTrendCustomerId] = useState<number | undefined>(undefined);
  const [trendJobType, setTrendJobType] = useState<string | undefined>(undefined);

  const { from, to } = getRange(period, anchor);
  const fromStr = format(from, "yyyy-MM-dd");
  const toStr = format(to, "yyyy-MM-dd");
  const label = rangeLabel(period, from, to);

  const companyName = company.name || BRAND_NAME;
  const companyLogo = company.logoDataUrl || BRAND_LOGO_URL;

  const trendParams = {
    from: fromStr,
    to: toStr,
    ...(trendCustomerId != null ? { trendCustomerId } : {}),
    ...(trendJobType != null ? { trendJobType } : {}),
  };

  const { data: stats, isLoading, isError: statsError, refetch: refetchStats } = useGetStatsOverview(
    trendParams,
    { query: { queryKey: getGetStatsOverviewQueryKey(trendParams), enabled: isAdmin } },
  );

  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey(), enabled: isAdmin } });

  const { data: risks, isLoading: risksLoading } = useGetRisksSummary(undefined, {
    query: { queryKey: getGetRisksSummaryQueryKey(), retry: false, enabled: isAdmin },
  });

  const shift = (dir: -1 | 1) => {
    setAnchor((prev) => {
      if (period === "week") return addWeeks(prev, dir);
      if (period === "month") return addMonths(prev, dir);
      return addYears(prev, dir);
    });
  };

  const handleDownload = async () => {
    const element = document.getElementById("statistika-list");
    if (!element) return;
    setExporting(true);
    try {
      const doc = await renderJobSheetPdf(element);
      doc.save(`statistika-${period}-${fromStr}.pdf`);
    } catch {
      toast({ variant: "destructive", title: "Export selhal", description: "PDF se nepodařilo vytvořit. Zkuste to prosím znovu." });
    } finally {
      setExporting(false);
    }
  };

  if (!authLoading && !isAdmin) {
    return (
      <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center p-8">
        <div className="bg-card rounded-2xl shadow-lg p-10 max-w-sm w-full flex flex-col items-center gap-4 text-center">
          <ShieldOff className="w-12 h-12 text-muted-foreground" />
          <h2 className="text-xl font-bold">Přístup zamítnut</h2>
          <p className="text-sm text-muted-foreground">Tato stránka je dostupná pouze pro administrátory.</p>
          <Button variant="outline" onClick={() => window.history.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Zpět
          </Button>
        </div>
      </div>
    );
  }

  // Chart data
  const chartData = stats?.trend.map((m) => ({
    name: monthLabel(m.month),
    "Vystaveno": Math.round(m.issuedWithVat),
    "Zaplaceno": Math.round(m.paid),
    "Hotové zakázky": m.doneJobsCount,
  })) ?? [];

  // Type-breakdown stacked bar chart data
  const TYPE_COLORS: Record<string, string> = {
    site_visit:    "#f97316",
    consultation:  "#a855f7",
    planned_work:  "#14b8a6",
    service_call:  "#ef4444",
    change:        "#6366f1",
    revize:        "#06b6d4",
    other:         "#6b7280",
  };
  // Collect all types that appear across all months (stable order: known types first, then unknown)
  const KNOWN_TYPES = Object.keys(TYPE_COLORS);
  const allTypesSet = new Set<string>();
  for (const m of stats?.trend ?? []) {
    for (const bt of m.byType) allTypesSet.add(bt.type);
  }
  const allTypes = [
    ...KNOWN_TYPES.filter((t) => allTypesSet.has(t)),
    ...[...allTypesSet].filter((t) => !KNOWN_TYPES.includes(t)),
  ];
  const typeBarData = stats?.trend.map((m) => {
    const byTypeMap = new Map(m.byType.map((bt) => [bt.type, bt.count]));
    const row: Record<string, string | number> = { name: monthLabel(m.month) };
    for (const t of allTypes) row[t] = byTypeMap.get(t) ?? 0;
    return row;
  }) ?? [];
  const hasTypeData = typeBarData.some((row) => allTypes.some((t) => (row[t] as number) > 0));

  return (
    <div className="min-h-[100dvh] bg-neutral-200 dark:bg-neutral-800 pb-16">
      <style>{PRINT_CSS}</style>

      {/* Toolbar */}
      <div className="no-print sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-3 max-w-5xl mx-auto w-full flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="shrink-0">
              <ArrowLeft className="h-6 w-6" />
            </Button>
            <h1 className="text-lg font-bold flex-1 min-w-0 truncate">Statistika</h1>
            <Button variant="outline" onClick={handleDownload} disabled={exporting || isLoading} className="shrink-0">
              {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Stáhnout PDF
            </Button>
            <Button onClick={() => window.print()} disabled={isLoading} className="shrink-0">
              <Printer className="h-4 w-4 mr-2" /> Tisk
            </Button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border bg-muted p-0.5">
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    period === p ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Předchozí období">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 text-sm font-semibold min-w-[10rem] text-center">{label}</span>
              <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Další období">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Screen Dashboard (no-print) ─────────────────────────────────────── */}
      <div className="no-print max-w-5xl mx-auto w-full px-4 pt-5 pb-4 space-y-5">
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : statsError ? (
          <QueryErrorState title="Nepodařilo se načíst statistiku" onRetry={() => refetchStats()} />
        ) : stats ? (
          <>
            {/* KPI Cards */}
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">KPI přehled — {label}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <KpiCard
                  label="Hodnota evidované práce"
                  value={fmtKcShort(stats.revenue.total)}
                  sub="bez DPH – zakázky v období"
                  delta={delta(stats.revenue.total, stats.comparison.revenueTotal)}
                  icon={<Briefcase className="h-4 w-4" />}
                />
                <KpiCard
                  label="Vystaveno s DPH"
                  value={fmtKcShort(stats.billing.issuedWithVat)}
                  sub={`${stats.billing.issuedCount} faktur v období`}
                  delta={delta(stats.billing.issuedWithVat, stats.comparison.issuedWithVat)}
                  href="/billing"
                  icon={<Banknote className="h-4 w-4" />}
                />
                <KpiCard
                  label="Zaplaceno"
                  value={fmtKcShort(stats.billing.paidAmount)}
                  sub={`${stats.billing.paidCount} plateb v období`}
                  delta={delta(stats.billing.paidAmount, stats.comparison.paid)}
                  icon={<TrendingUp className="h-4 w-4" />}
                />
                <KpiCard
                  label="K inkasu"
                  value={fmtKcShort(stats.billing.toCollectAmount)}
                  sub={`${stats.billing.toCollectCount} faktur čeká na platbu`}
                  href="/billing?status=issued"
                  icon={<ShoppingCart className="h-4 w-4" />}
                />
                <KpiCard
                  label="Po splatnosti"
                  value={fmtKcShort(stats.billing.overdueAmount)}
                  sub={`${stats.billing.overdueCount} faktur po splatnosti`}
                  href="/billing/invoices?overdue=true"
                  urgent={stats.billing.overdueCount > 0}
                  icon={<AlertTriangle className="h-4 w-4" />}
                />
                <KpiCard
                  label="K fakturaci bez DPH"
                  value={fmtKcShort(stats.readyToBill.amount)}
                  sub={`${stats.readyToBill.jobsCount} zakázek · ${stats.readyToBill.activitiesCount} akcí`}
                  href="/billing/unbilled"
                  urgent={stats.readyToBill.count > 0}
                  icon={<FileMinus className="h-4 w-4" />}
                />
              </div>
            </div>

            {/* 6-month chart */}
            {chartData.length > 0 && (
              <div className="rounded-xl border bg-card p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                    Vývoj posledních 6 měsíců
                    {(trendCustomerId != null || trendJobType != null) && (
                      <span className="ml-1 normal-case font-medium text-foreground">
                        {[
                          trendCustomerId != null ? (customers?.find((c) => c.id === trendCustomerId)?.companyName ?? "Zákazník") : null,
                          trendJobType != null ? (JOB_TYPES[trendJobType as keyof typeof JOB_TYPES]?.label ?? trendJobType) : null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </h2>
                  <div className="no-print flex items-center gap-2 flex-wrap">
                    <Select
                      value={trendCustomerId != null ? String(trendCustomerId) : "all"}
                      onValueChange={(v) => setTrendCustomerId(v === "all" ? undefined : Number(v))}
                    >
                      <SelectTrigger className="h-7 text-xs w-44">
                        <SelectValue placeholder="Zákazník" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Všichni zákazníci</SelectItem>
                        {(customers ?? []).map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>{c.companyName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={trendJobType ?? "all"}
                      onValueChange={(v) => setTrendJobType(v === "all" ? undefined : v)}
                    >
                      <SelectTrigger className="h-7 text-xs w-44">
                        <SelectValue placeholder="Typ zakázky" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Všechny typy</SelectItem>
                        {(Object.entries(JOB_TYPES) as [string, { label: string }][]).map(([key, { label }]) => (
                          <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="h-48 sm:h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gradIssued" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gradPaid" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                        yAxisId="left"
                      />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
                      <Tooltip
                        formatter={(value: number, name: string) =>
                          name === "Hotové zakázky"
                            ? [value, name]
                            : [fmtKc(value), name]
                        }
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area
                        yAxisId="left"
                        type="monotone"
                        dataKey="Vystaveno"
                        stroke="#6366f1"
                        fill="url(#gradIssued)"
                        strokeWidth={2}
                        dot={false}
                      />
                      <Area
                        yAxisId="left"
                        type="monotone"
                        dataKey="Zaplaceno"
                        stroke="#10b981"
                        fill="url(#gradPaid)"
                        strokeWidth={2}
                        dot={false}
                      />
                      <Area
                        yAxisId="right"
                        type="monotone"
                        dataKey="Hotové zakázky"
                        stroke="#f59e0b"
                        fill="none"
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Job-type stacked bar chart */}
            {hasTypeData && (
              <div className="rounded-xl border bg-card p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                    Hotové zakázky podle typu — posledních 6 měsíců
                    {trendCustomerId != null && (
                      <span className="ml-1 normal-case font-medium text-foreground">
                        · {customers?.find((c) => c.id === trendCustomerId)?.companyName ?? "Zákazník"}
                      </span>
                    )}
                  </h2>
                </div>
                <div className="h-48 sm:h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={typeBarData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip
                        formatter={(value: number, name: string) => [value, typeLabel(name)]}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 11 }}
                        formatter={(value: string) => typeLabel(value)}
                      />
                      {allTypes.map((type) => (
                        <Bar
                          key={type}
                          dataKey={type}
                          stackId="types"
                          fill={TYPE_COLORS[type] ?? "#94a3b8"}
                          radius={0}
                          opacity={
                            trendJobType == null || trendJobType === type
                              ? 1
                              : 0.2
                          }
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Operational quick-links */}
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Provoz</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Zakázky", sub: `${stats.jobs.total} v období`, href: "/jobs", icon: <Briefcase className="h-5 w-5" /> },
                  { label: "Dlouhodobé akce", sub: "přehled akcí", href: "/activities", icon: <Activity className="h-5 w-5" /> },
                  { label: "OOPP", sub: `${stats.ppe.issued} vydáno`, href: "/stroje/oopp", icon: <HardHat className="h-5 w-5" /> },
                  { label: "Sklad", sub: `${stats.warehouse.itemCount} položek`, href: "/sklad", icon: <Warehouse className="h-5 w-5" /> },
                ].map((item) => (
                  <Link key={item.href} href={item.href}>
                    <div className="rounded-xl border bg-card p-3 flex items-center gap-3 hover:bg-accent/50 transition-colors cursor-pointer">
                      <span className="text-muted-foreground shrink-0">{item.icon}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold leading-tight">{item.label}</div>
                        <div className="text-xs text-muted-foreground">{item.sub}</div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground ml-auto shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>

            {/* Top customers */}
            {stats.topCustomers.length > 0 && (
              <div className="rounded-xl border bg-card p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Největší zákazníci dle fakturace — {label}</h2>
                <div className="divide-y">
                  {stats.topCustomers.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="text-sm text-muted-foreground font-mono w-5 text-right shrink-0">{idx + 1}</span>
                      {c.customerId ? (
                        <Link href={`/customers/${c.customerId}`} className="flex-1 min-w-0 text-sm font-medium hover:underline truncate">
                          {c.customerName}
                        </Link>
                      ) : (
                        <span className="flex-1 min-w-0 text-sm font-medium truncate">{c.customerName}</span>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">{c.invoiceCount} fakt.</span>
                      <span className="text-sm font-semibold shrink-0">{fmtKcShort(c.totalWithVat)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PPE block */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">OOPP – osobní ochranné pracovní prostředky</h2>
                <Link href="/stroje/oopp">
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                    Přehled <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="text-center">
                  <div className="text-2xl font-bold">{stats.ppe.issued}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Vydáno (aktivní)</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-emerald-600">{stats.ppe.signed}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Podepsáno</div>
                </div>
                <div className="text-center">
                  <div className={`text-2xl font-bold ${stats.ppe.unsigned > 0 ? "text-amber-600" : ""}`}>
                    {stats.ppe.unsigned}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Bez podpisu</div>
                </div>
                <div className="text-center">
                  <div className={`text-2xl font-bold ${stats.ppe.overdue > 0 ? "text-red-600" : ""}`}>
                    {stats.ppe.overdue}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Po termínu výměny</div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* ── Detailed Report (printable) ─────────────────────────────────────── */}
      <div className="max-w-3xl mx-auto w-full px-4 md:px-8">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : statsError ? null : !stats ? (
          <div className="p-8 text-center text-muted-foreground">Žádná data pro zvolené období.</div>
        ) : (
          <div id="statistika-list" className="bg-white text-neutral-900 shadow-lg mx-auto p-8 md:p-10" style={{ maxWidth: "210mm" }}>
            {/* Header */}
            <div className="flex items-start justify-between border-b-2 border-neutral-900 pb-4 mb-6">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Statistika</h2>
                <p className="text-sm text-neutral-600 mt-1">{PERIOD_LABELS[period]}: {label}</p>
                {(trendCustomerId != null || trendJobType != null) && (
                  <p className="text-sm text-neutral-600 mt-0.5">
                    Filtr:{" "}
                    {[
                      trendCustomerId != null ? (customers?.find((c) => c.id === trendCustomerId)?.companyName ?? "Zákazník") : null,
                      trendJobType != null ? (JOB_TYPES[trendJobType as keyof typeof JOB_TYPES]?.label ?? trendJobType) : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end text-right">
                <img src={companyLogo} alt={companyName} crossOrigin="anonymous" className="h-16 w-auto object-contain" />
                <p className="text-xs text-neutral-500 mt-1">Vystaveno: {format(new Date(), "d. M. yyyy")}</p>
              </div>
            </div>

            {/* Jobs overview */}
            <Section title="Zakázky" icon={<Briefcase className="w-4 h-4" />}>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-4">
                <Stat label="Celkem" value={String(stats.jobs.total)} />
                <Stat label="Naplánováno" value={String(stats.jobs.planned)} />
                <Stat label="Probíhá" value={String(stats.jobs.inProgress)} />
                <Stat label="Hotovo" value={String(stats.jobs.done)} />
                <Stat label="Zrušeno" value={String(stats.jobs.cancelled)} />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4 max-w-sm">
                <Stat label="Odpracované hodiny" value={fmtHours(stats.jobs.totalHours)} />
              </div>
              {stats.jobs.byType.length > 0 && (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-300 text-left text-neutral-600">
                      <th className="py-1 pr-2 font-semibold">Druh zakázky</th>
                      <th className="py-1 pl-2 font-semibold text-right">Počet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.jobs.byType.map((row) => (
                      <tr key={row.type} className="border-b border-neutral-200">
                        <td className="py-1 pr-2">{typeLabel(row.type)}</td>
                        <td className="py-1 pl-2 text-right font-medium">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {hasTypeData && typeBarData.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
                    Hotové zakázky dle druhu — měsíční přehled
                  </p>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-neutral-300 text-neutral-600">
                        <th className="py-1 pr-2 font-semibold text-left">Měsíc</th>
                        {allTypes.map((t) => (
                          <th key={t} className="py-1 px-1 font-semibold text-right whitespace-nowrap">
                            {typeLabel(t)}
                          </th>
                        ))}
                        <th className="py-1 pl-2 font-semibold text-right">Celkem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typeBarData.map((row) => {
                        const rowTotal = allTypes.reduce((s, t) => s + ((row[t] as number) || 0), 0);
                        return (
                          <tr key={row.name as string} className="border-b border-neutral-200">
                            <td className="py-1 pr-2 font-medium">{row.name as string}</td>
                            {allTypes.map((t) => (
                              <td key={t} className="py-1 px-1 text-right text-neutral-600">
                                {(row[t] as number) > 0 ? row[t] as number : "—"}
                              </td>
                            ))}
                            <td className="py-1 pl-2 text-right font-medium">{rowTotal > 0 ? rowTotal : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* Revenue — renamed from "Tržby" with explanation */}
            <Section title="Hodnota evidované práce" icon={<Banknote className="w-4 h-4" />}>
              <p className="text-xs text-neutral-500 mb-3">
                Interní hodnota bez DPH (zakázky v daném období) — <em>nejedná se o fakturované tržby</em>.
              </p>
              <div className="text-sm space-y-1 max-w-sm">
                <PriceRow label="Práce a doprava" value={fmtKc(stats.revenue.work)} />
                <PriceRow label="Materiál" value={fmtKc(stats.revenue.material)} />
                {stats.revenue.transport > 0 && <PriceRow label="z toho doprava" value={fmtKc(stats.revenue.transport)} muted />}
                {stats.revenue.parking > 0 && <PriceRow label="z toho parkování" value={fmtKc(stats.revenue.parking)} muted />}
                {stats.revenue.fines > 0 && <PriceRow label="z toho pokuty" value={fmtKc(stats.revenue.fines)} muted />}
                <div className="flex justify-between border-t-2 border-neutral-900 pt-2 mt-2 text-base font-bold">
                  <span>Celkem</span>
                  <span>{fmtKc(stats.revenue.total)}</span>
                </div>
                <p className="text-xs text-neutral-500">Ceny jsou uvedeny bez DPH.</p>
              </div>
            </Section>

            {/* Employees */}
            <Section title="Zaměstnanci" icon={<Users className="w-4 h-4" />}>
              {stats.employees.length === 0 ? (
                <p className="text-sm text-neutral-500">V tomto období bez aktivity.</p>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-300 text-left text-neutral-600">
                      <th className="py-1 pr-2 font-semibold">Jméno</th>
                      <th className="py-1 px-2 font-semibold text-right">Zakázky</th>
                      <th className="py-1 pl-2 font-semibold text-right">Hodiny</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.employees.map((e) => (
                      <tr key={e.personId} className="border-b border-neutral-200">
                        <td className="py-1 pr-2">{e.name}</td>
                        <td className="py-1 px-2 text-right">{e.jobs}</td>
                        <td className="py-1 pl-2 text-right font-medium">{fmtHours(e.hours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Materials */}
            <Section title="Materiál" icon={<Package className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-3 mb-4 max-w-sm">
                <Stat label="Náklady na materiál" value={fmtKc(stats.materials.totalCost)} />
              </div>
              {stats.materials.top.length === 0 ? (
                <p className="text-sm text-neutral-500">V tomto období bez materiálu.</p>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-300 text-left text-neutral-600">
                      <th className="py-1 pr-2 font-semibold">Položka</th>
                      <th className="py-1 px-2 font-semibold text-right">Množství</th>
                      <th className="py-1 pl-2 font-semibold text-right">Náklady</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.materials.top.map((m) => (
                      <tr key={m.name} className="border-b border-neutral-200">
                        <td className="py-1 pr-2">{m.name}</td>
                        <td className="py-1 px-2 text-right">{m.quantity.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })}</td>
                        <td className="py-1 pl-2 text-right font-medium">{fmtKc(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Warehouse */}
            <Section title="Sklad" icon={<Warehouse className="w-4 h-4" />}>
              <p className="text-xs text-neutral-500 mb-2">Aktuální stav skladu (nezávisí na zvoleném období).</p>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Položek" value={String(stats.warehouse.itemCount)} />
                <Stat label="Hodnota skladu" value={fmtKc(stats.warehouse.stockValue)} />
                <Stat label="Pod minimem" value={String(stats.warehouse.lowStockCount)} />
              </div>
            </Section>

            {/* Material profit */}
            <Section title="Zisk z materiálu" icon={<TrendingUp className="w-4 h-4" />}>
              <p className="text-xs text-neutral-500 mb-3">Výdeje ze skladu za zvolené období.</p>
              <div className="text-sm space-y-1 max-w-sm mb-4">
                <PriceRow label="Tržby z materiálu" value={fmtKc(stats.warehouse.materialSaleRevenue)} />
                <PriceRow label="Náklady na materiál" value={fmtKc(stats.warehouse.materialPurchaseCost)} />
                <div className="flex justify-between border-t-2 border-neutral-900 pt-2 mt-2 text-base font-bold">
                  <span>Hrubý zisk</span>
                  <span className={stats.warehouse.materialGrossProfit >= 0 ? "text-green-700" : "text-red-600"}>
                    {fmtKc(stats.warehouse.materialGrossProfit)}
                  </span>
                </div>
                {stats.warehouse.incompleteMovements > 0 && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <span>
                      <strong>{stats.warehouse.incompleteMovements}</strong>{" "}
                      {stats.warehouse.incompleteMovements === 1
                        ? "pohyb bez nákupní ceny"
                        : stats.warehouse.incompleteMovements < 5
                          ? "pohyby bez nákupní ceny"
                          : "pohybů bez nákupní ceny"}
                      {stats.warehouse.incompleteMovementsShare > 0 && (
                        <> ({Math.round(stats.warehouse.incompleteMovementsShare * 100)}&nbsp;%)</>
                      )}{" "}
                      — zisk může být podhodnocen
                    </span>
                  </div>
                )}
              </div>
              {stats.warehouse.topProfitItems.length > 0 && (
                <ProfitItemsTable
                  items={stats.warehouse.topProfitItems}
                  sort={profitSort}
                  onSort={(col) =>
                    setProfitSort(
                      profitSort.col === col
                        ? { col, dir: profitSort.dir === "desc" ? "asc" : "desc" }
                        : { col, dir: col === "name" ? "asc" : "desc" }
                    )
                  }
                  filter={profitFilter}
                  onFilter={setProfitFilter}
                  csvFilename={`sklad-zisk-${fromStr}_${toStr}.csv`}
                />
              )}
            </Section>

            {/* Risks */}
            {risksLoading ? (
              <div className="mb-6 border border-neutral-300 rounded-md p-4 space-y-2">
                <div className="h-4 bg-neutral-200 rounded w-2/3 animate-pulse" />
                <div className="h-3 bg-neutral-100 rounded w-full animate-pulse" />
                <div className="h-3 bg-neutral-100 rounded w-full animate-pulse" />
              </div>
            ) : risks ? (
              <Section title="Rizika a nevyfakturované práce" icon={<AlertTriangle className="w-4 h-4" />}>
                <p className="text-xs text-neutral-500 mb-3">Aktuální stav — nezávisí na zvoleném období. Kliknutím přejdete do příslušné fronty.</p>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-300 text-left text-neutral-600">
                      <th className="py-1 pr-2 font-semibold">Riziko</th>
                      <th className="py-1 px-2 font-semibold text-right">Počet</th>
                      <th className="py-1 pl-2 font-semibold text-right">Částka</th>
                    </tr>
                  </thead>
                  <tbody>
                    <RiskStatRow
                      icon={<Banknote className="w-3.5 h-3.5" />}
                      label="Hotové k fakturaci"
                      count={risks.readyToBill.count}
                      amount={risks.readyToBill.amount}
                      href={buildRiskUrl(risks.readyToBill.filter)}
                      urgent
                    />
                    <RiskStatRow
                      icon={<FileSearch className="w-3.5 h-3.5" />}
                      label="Doklady ke kontrole"
                      count={risks.documentsForReview.count}
                      href={buildRiskUrl(risks.documentsForReview.filter)}
                      urgent
                    />
                    <RiskStatRow
                      icon={<FileMinus className="w-3.5 h-3.5" />}
                      label="Doklady bez zakázky"
                      count={risks.documentsWithoutJob.count}
                      href={buildRiskUrl(risks.documentsWithoutJob.filter)}
                    />
                    <RiskStatRow
                      icon={<PackageMinus className="w-3.5 h-3.5" />}
                      label="Sklad pod minimem"
                      count={risks.warehouseBelowMin.count}
                      href={buildRiskUrl(risks.warehouseBelowMin.filter)}
                    />
                    <RiskStatRow
                      icon={<UserX className="w-3.5 h-3.5" />}
                      label="Zakázky bez zákazníka"
                      count={risks.jobsWithoutCustomer.count}
                      href={buildRiskUrl(risks.jobsWithoutCustomer.filter)}
                    />
                    <RiskStatRow
                      icon={<Tag className="w-3.5 h-3.5" />}
                      label="Materiál bez ceny"
                      count={risks.materialsWithoutPrice.count}
                      href={buildRiskUrl(risks.materialsWithoutPrice.filter)}
                    />
                    <RiskStatRow
                      icon={<Clock className="w-3.5 h-3.5" />}
                      label={`Rozpracované déle než ${risks.staleDays} dní`}
                      count={risks.longInProgress.count}
                      href={buildRiskUrl(risks.longInProgress.filter)}
                    />
                    <RiskStatRow
                      icon={<Banknote className="w-3.5 h-3.5" />}
                      label="Zákazníci s fakturou >7 dní"
                      count={risks.overdueUnbilledCustomers.count}
                      href={buildRiskUrl(risks.overdueUnbilledCustomers.filter)}
                    />
                    {risks.machinesInspectionExpired && risks.machinesInspectionExpired.count > 0 && (
                      <RiskStatRow
                        icon={<Wrench className="w-3.5 h-3.5" />}
                        label="Stroje — prošlá revize"
                        count={risks.machinesInspectionExpired.count}
                        href={buildRiskUrl(risks.machinesInspectionExpired.filter)}
                        urgent
                      />
                    )}
                    {risks.machinesInspectionSoon && risks.machinesInspectionSoon.count > 0 && (
                      <RiskStatRow
                        icon={<Wrench className="w-3.5 h-3.5" />}
                        label="Stroje — revize do 30 dní"
                        count={risks.machinesInspectionSoon.count}
                        href={buildRiskUrl(risks.machinesInspectionSoon.filter)}
                      />
                    )}
                  </tbody>
                </table>
              </Section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

type RiskStatRowProps = {
  icon: React.ReactNode;
  label: string;
  count: number;
  amount?: number | null;
  href: string;
  urgent?: boolean;
};

function RiskStatRow({ icon, label, count, amount, href, urgent }: RiskStatRowProps) {
  const hasIssue = count > 0;
  return (
    <tr className={`border-b border-neutral-200 ${hasIssue ? "" : "opacity-40"}`}>
      <td className="py-1.5 pr-2">
        <Link href={href} className="flex items-center gap-1.5 hover:underline group">
          <span className={hasIssue ? (urgent ? "text-red-500" : "text-amber-600") : "text-neutral-400"}>
            {icon}
          </span>
          <span className={`text-sm ${hasIssue ? "font-medium" : "text-neutral-500"}`}>{label}</span>
        </Link>
      </td>
      <td className="py-1.5 px-2 text-right">
        <Link href={href}>
          <span className={`text-sm font-bold ${hasIssue ? (urgent ? "text-red-600" : "text-amber-700") : "text-neutral-400"}`}>
            {count}
          </span>
        </Link>
      </td>
      <td className="py-1.5 pl-2 text-right text-sm text-neutral-500">
        {amount != null && hasIssue ? fmtKcBilling(amount, 0) : "—"}
      </td>
    </tr>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-bold uppercase tracking-wide border-b border-neutral-300 pb-1 mb-3 flex items-center gap-1.5">
        {icon}{title}
      </h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-neutral-300 rounded-md p-3">
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="text-[11px] text-neutral-500 font-medium mt-1">{label}</div>
    </div>
  );
}

function PriceRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? "text-neutral-500 text-xs pl-3" : ""}`}>
      <span className={muted ? "" : "text-neutral-600"}>{label}</span>
      <span className={muted ? "" : "font-medium"}>{value}</span>
    </div>
  );
}

type ProfitItem = {
  name: string;
  quantityIssued: number;
  saleRevenue: number;
  purchaseCost: number;
  grossProfit: number;
};

function SortIcon({ col, sort }: { col: ProfitCol; sort: { col: ProfitCol; dir: SortDir } }) {
  if (sort.col !== col) return <ChevronsUpDown className="inline h-3 w-3 ml-0.5 opacity-40" />;
  return sort.dir === "asc"
    ? <ChevronUp className="inline h-3 w-3 ml-0.5 text-neutral-800" />
    : <ChevronDown className="inline h-3 w-3 ml-0.5 text-neutral-800" />;
}

function ProfitItemsTable({
  items,
  sort,
  onSort,
  filter,
  onFilter,
  csvFilename,
}: {
  items: ProfitItem[];
  sort: { col: ProfitCol; dir: SortDir };
  onSort: (col: ProfitCol) => void;
  filter: string;
  onFilter: (v: string) => void;
  csvFilename?: string;
}) {
  const filterLower = filter.trim().toLowerCase();
  const filtered = filterLower
    ? items.filter((i) => i.name.toLowerCase().includes(filterLower))
    : items;

  const getMargin = (item: ProfitItem) =>
    item.saleRevenue > 0 ? (item.grossProfit / item.saleRevenue) * 100 : null;

  const sorted = [...filtered].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    if (sort.col === "name") return dir * a.name.localeCompare(b.name, "cs");
    if (sort.col === "margin") {
      const ma = getMargin(a) ?? -Infinity;
      const mb = getMargin(b) ?? -Infinity;
      return dir * (ma - mb);
    }
    return dir * (a[sort.col] - b[sort.col]);
  });

  const thClass = (col: ProfitCol, align: "left" | "right" = "right") =>
    `py-1 font-semibold cursor-pointer select-none whitespace-nowrap hover:text-neutral-900 transition-colors ${align === "right" ? "px-2 text-right" : "pr-2 text-left"} ${sort.col === col ? "text-neutral-900" : "text-neutral-500"}`;

  const handleDownloadCsv = () => {
    if (sorted.length === 0) return;
    const rows = [
      ["Položka", "Vydáno", "Tržby (Kč)", "Náklady (Kč)", "Zisk (Kč)", "Marže (%)"],
      ...sorted.map((item) => {
        const m = getMargin(item);
        return [
          item.name,
          item.quantityIssued.toLocaleString("cs-CZ", { maximumFractionDigits: 2 }),
          Math.round(item.saleRevenue).toString(),
          Math.round(item.purchaseCost).toString(),
          Math.round(item.grossProfit).toString(),
          m === null ? "" : m.toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        ];
      }),
    ];
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename ?? "sklad-zisk.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Položky skladu</h4>
        <button
          onClick={handleDownloadCsv}
          className="no-print inline-flex items-center gap-1 text-xs font-medium text-neutral-600 border border-neutral-300 rounded px-2 py-1 hover:bg-neutral-100 transition-colors"
          title="Stáhnout jako CSV pro Excel"
        >
          <Download className="w-3 h-3" />
          Stáhnout CSV
        </button>
      </div>
      <div className="no-print relative mb-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
        <Input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Filtrovat dle názvu…"
          className="pl-8 h-8 text-sm bg-white border-neutral-300 text-neutral-900"
        />
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-neutral-400 py-2">Žádné položky neodpovídají filtru.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-neutral-300 text-left">
              <th className={thClass("name", "left")} onClick={() => onSort("name")}>
                Položka <SortIcon col="name" sort={sort} />
              </th>
              <th className={thClass("quantityIssued")} onClick={() => onSort("quantityIssued")}>
                Vydáno <SortIcon col="quantityIssued" sort={sort} />
              </th>
              <th className={thClass("saleRevenue")} onClick={() => onSort("saleRevenue")}>
                Tržby <SortIcon col="saleRevenue" sort={sort} />
              </th>
              <th className={thClass("purchaseCost")} onClick={() => onSort("purchaseCost")}>
                Náklady <SortIcon col="purchaseCost" sort={sort} />
              </th>
              <th className={thClass("grossProfit")} onClick={() => onSort("grossProfit")}>
                Zisk <SortIcon col="grossProfit" sort={sort} />
              </th>
              <th className={thClass("margin")} style={{ paddingLeft: "0.5rem" }} onClick={() => onSort("margin")}>
                Marže <SortIcon col="margin" sort={sort} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => {
              const margin = getMargin(item);
              return (
                <tr key={item.name} className="border-b border-neutral-200">
                  <td className="py-1 pr-2">{item.name}</td>
                  <td className="py-1 px-2 text-right text-neutral-600">
                    {item.quantityIssued.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })}
                  </td>
                  <td className="py-1 px-2 text-right">{fmtKc(item.saleRevenue)}</td>
                  <td className="py-1 px-2 text-right text-neutral-600">{fmtKc(item.purchaseCost)}</td>
                  <td className={`py-1 px-2 text-right font-medium ${item.grossProfit >= 0 ? "text-green-700" : "text-red-600"}`}>
                    {fmtKc(item.grossProfit)}
                  </td>
                  <td className={`py-1 pl-2 text-right font-medium ${margin === null ? "text-neutral-400" : margin >= 0 ? "text-green-700" : "text-red-600"}`}>
                    {margin === null ? "—" : `${margin.toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
