import { useLocation } from "wouter";
import {
  useGetBillingSummary,
  getGetBillingSummaryQueryKey,
  useListCostDocuments,
  getListCostDocumentsQueryKey,
  type ListCostDocumentsParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtKc } from "@/lib/billing-format";
import {
  Receipt,
  FileEdit,
  FileText,
  Briefcase,
  ChevronRight,
  Building2,
  Inbox,
  Settings as SettingsIcon,
  AlertTriangle,
  Banknote,
  Sparkles,
  Mail,
  CheckCircle2,
} from "lucide-react";

const NEEDS_REVIEW_PARAMS: ListCostDocumentsParams = { status: "needs_review" };
const AI_REVIEW_PARAMS: ListCostDocumentsParams = {
  status: "needs_review",
  aiOnly: true,
};

export default function Billing() {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useGetBillingSummary({
    query: { queryKey: getGetBillingSummaryQueryKey() },
  });
  const { data: reviewDocs } = useListCostDocuments(NEEDS_REVIEW_PARAMS, {
    query: { queryKey: getListCostDocumentsQueryKey(NEEDS_REVIEW_PARAMS) },
  });
  const { data: aiReviewDocs } = useListCostDocuments(AI_REVIEW_PARAMS, {
    query: { queryKey: getListCostDocumentsQueryKey(AI_REVIEW_PARAMS) },
  });

  const reviewCount = reviewDocs?.length ?? 0;
  const aiReviewCount = aiReviewDocs?.length ?? 0;
  const unbilledCount = (data?.unbilledDoneJobs ?? 0) + (data?.unbilledActivities ?? 0);
  const overdueCount = data?.overdueCount ?? 0;

  const hasUrgentItems =
    unbilledCount > 0 || reviewCount > 0 || overdueCount > 0 || aiReviewCount > 0;

  const queueItems = [
    {
      key: "unbilled",
      icon: Building2,
      label: "Hotové k fakturaci",
      subtitle: "Zakázky čekající na vystavení faktury",
      count: unbilledCount,
      amount: data?.totalToInvoiceWithoutVat,
      amountLabel: "orientačně bez DPH",
      urgent: unbilledCount > 0,
      urgentColor: "text-amber-600 dark:text-amber-400",
      urgentBg: "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20",
      iconColor: "text-amber-500",
      onClick: () => setLocation("/billing/unbilled"),
    },
    {
      key: "review",
      icon: Inbox,
      label: "Doklady ke kontrole",
      subtitle: "Přijaté doklady čekající na schválení",
      count: reviewCount,
      urgent: reviewCount > 0,
      urgentColor: "text-emerald-700 dark:text-emerald-400",
      urgentBg:
        "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/20",
      iconColor: "text-emerald-500",
      onClick: () => setLocation("/billing/documents?status=needs_review"),
    },
    {
      key: "ai",
      icon: Sparkles,
      label: "AI ke kontrole",
      subtitle: "Doklady předvyplněné AI čekající na potvrzení",
      count: aiReviewCount,
      urgent: aiReviewCount > 0,
      urgentColor: "text-violet-700 dark:text-violet-400",
      urgentBg:
        "border-violet-200 bg-violet-50 dark:border-violet-900/50 dark:bg-violet-950/20",
      iconColor: "text-violet-500",
      onClick: () => setLocation("/billing/documents/review"),
    },
    {
      key: "overdue",
      icon: AlertTriangle,
      label: "Po splatnosti",
      subtitle: "Vystavené faktury po datu splatnosti",
      count: overdueCount,
      amount: data?.overdueTotalWithVat,
      amountLabel: "s DPH",
      urgent: overdueCount > 0,
      urgentColor: "text-red-700 dark:text-red-400",
      urgentBg: "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20",
      iconColor: "text-red-500",
      onClick: () => setLocation("/billing/invoices?status=overdue"),
    },
  ];

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-6">
        <div className="bg-violet-100 dark:bg-violet-900/30 p-2.5 rounded-full text-violet-600 dark:text-violet-300">
          <Receipt className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold">Fakturace</h1>
      </div>

      {/* Work queue */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        K vyřízení
      </h2>

      {isLoading ? (
        <div className="space-y-2 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : !hasUrgentItems ? (
        <Card className="mb-6">
          <CardContent className="p-4 flex items-center gap-3 text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
            <p className="text-sm">Nic k vyřízení – vše je v pořádku.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 mb-6">
          {queueItems
            .filter((q) => q.urgent)
            .map((q) => (
              <QueueCard key={q.key} item={q} />
            ))}
        </div>
      )}

      {/* Secondary: zero-count items */}
      {!isLoading && hasUrgentItems && (
        <div className="space-y-2 mb-6">
          {queueItems
            .filter((q) => !q.urgent)
            .map((q) => (
              <QueueCard key={q.key} item={q} muted />
            ))}
        </div>
      )}

      {/* Financial metrics */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Přehled
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <MetricCard
          label="K vyfakturování"
          sublabel="bez DPH"
          value={isLoading ? "—" : fmtKc(data?.totalToInvoiceWithoutVat, 0)}
        />
        <MetricCard
          label="Vystaveno letos"
          sublabel="s DPH"
          value={isLoading ? "—" : fmtKc(data?.issuedThisMonthWithVat, 0)}
        />
        <MetricCard
          label="Zaplaceno"
          sublabel={`letos · ${data?.paidThisMonthCount ?? 0} fakt.`}
          value={isLoading ? "—" : fmtKc(data?.paidThisMonthWithVat, 0)}
          valueColor="text-emerald-600 dark:text-emerald-400"
        />
        <MetricCard
          label="Nezaplaceno"
          sublabel={`${data?.unpaidCount ?? 0} ${invoiceNoun(data?.unpaidCount ?? 0)}`}
          value={isLoading ? "—" : fmtKc(data?.unpaidTotalWithVat, 0)}
        />
      </div>

      {/* Navigation links */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Fakturace
      </h2>
      <div className="space-y-2">
        <NavCard
          icon={Building2}
          color="text-amber-500"
          title="Hotové k fakturaci"
          subtitle="Vytvořte fakturu z hotových zakázek podle zákazníka"
          badge={unbilledCount}
          onClick={() => setLocation("/billing/unbilled")}
        />
        <NavCard
          icon={Inbox}
          color="text-emerald-500"
          title="Doklady a dodací listy"
          subtitle="Účtenky, dodací listy, přijaté faktury a dobropisy"
          badge={reviewCount}
          onClick={() => setLocation("/billing/documents")}
        />
        <NavCard
          icon={Sparkles}
          color="text-violet-500"
          title="AI kontrola dokladů"
          subtitle="Doklady předvyplněné AI čekající na potvrzení"
          badge={aiReviewCount}
          onClick={() => setLocation("/billing/documents/review")}
        />
        <NavCard
          icon={FileText}
          color="text-blue-500"
          title="Faktury"
          subtitle="Koncepty a vystavené faktury"
          badge={data?.draftInvoices}
          onClick={() => setLocation("/billing/invoices")}
        />
        <NavCard
          icon={Mail}
          color="text-teal-500"
          title="Platby z banky"
          subtitle="Nahrajte výpis (KB/CAMT) a spárujte platby s fakturami"
          onClick={() => setLocation("/billing/bank-import")}
        />
        <NavCard
          icon={Mail}
          color="text-sky-500"
          title="Import z e-mailu"
          subtitle="Stahování příloh z Gmailu ke kontrole"
          onClick={() => setLocation("/billing/email-import")}
        />
        <NavCard
          icon={SettingsIcon}
          color="text-gray-500"
          title="Nastavení fakturace"
          subtitle="Firma, číslování, DPH, AI a upomínky"
          onClick={() => setLocation("/billing/settings")}
        />
      </div>
    </div>
  );
}

function invoiceNoun(count: number): string {
  if (count === 1) return "faktura";
  if (count >= 2 && count <= 4) return "faktury";
  return "faktur";
}

type QueueItem = {
  key: string;
  icon: typeof Receipt;
  label: string;
  subtitle: string;
  count: number;
  amount?: number | null;
  amountLabel?: string;
  urgent: boolean;
  urgentColor: string;
  urgentBg: string;
  iconColor: string;
  onClick: () => void;
};

function QueueCard({ item, muted }: { item: QueueItem; muted?: boolean }) {
  return (
    <Card
      className={`overflow-hidden transition-colors ${
        !muted && item.urgent ? item.urgentBg : ""
      }`}
    >
      <button
        type="button"
        onClick={item.onClick}
        className="w-full text-left hover:bg-muted/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <CardContent className="p-3 flex items-center gap-3">
          <item.icon
            className={`h-5 w-5 shrink-0 ${muted ? "text-muted-foreground" : item.iconColor}`}
          />
          <div className="flex-1 min-w-0">
            <p
              className={`font-medium text-sm ${
                muted ? "text-muted-foreground" : ""
              }`}
            >
              {item.label}
            </p>
            <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
          </div>
          <div className="shrink-0 text-right">
            {item.count > 0 ? (
              <>
                <span
                  className={`text-lg font-bold ${!muted ? item.urgentColor : "text-muted-foreground"}`}
                >
                  {item.count}
                </span>
                {item.amount != null && item.amount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {fmtKc(item.amount, 0)} {item.amountLabel}
                  </p>
                )}
              </>
            ) : (
              <CheckCircle2 className="h-4 w-4 text-muted-foreground/40" />
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </CardContent>
      </button>
    </Card>
  );
}

function MetricCard({
  label,
  sublabel,
  value,
  valueColor,
}: {
  label: string;
  sublabel?: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className={`text-lg font-bold ${valueColor ?? ""}`}>{value}</div>
        <div className="text-xs font-medium text-foreground/80 leading-tight">{label}</div>
        {sublabel && (
          <div className="text-xs text-muted-foreground leading-tight">{sublabel}</div>
        )}
      </CardContent>
    </Card>
  );
}

function NavCard({
  icon: Icon,
  color,
  title,
  subtitle,
  badge,
  onClick,
}: {
  icon: typeof Receipt;
  color: string;
  title: string;
  subtitle: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <CardContent className="p-4 flex items-center gap-3">
          <div className="bg-muted p-2.5 rounded-full shrink-0">
            <Icon className={`h-5 w-5 ${color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-base">{title}</p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          {badge != null && badge > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-violet-600 text-white text-xs font-semibold min-w-[1.5rem] h-6 px-2 shrink-0">
              {badge}
            </span>
          )}
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
        </CardContent>
      </button>
    </Card>
  );
}
