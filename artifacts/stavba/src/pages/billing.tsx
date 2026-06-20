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
} from "lucide-react";

const AI_REVIEW_PARAMS: ListCostDocumentsParams = {
  status: "needs_review",
  aiOnly: true,
};

export default function Billing() {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useGetBillingSummary({
    query: { queryKey: getGetBillingSummaryQueryKey() },
  });
  const { data: aiReviewDocs } = useListCostDocuments(AI_REVIEW_PARAMS, {
    query: { queryKey: getListCostDocumentsQueryKey(AI_REVIEW_PARAMS) },
  });
  const aiReviewCount = aiReviewDocs?.length ?? 0;

  const stats = [
    {
      label: "Nevyfakturované zakázky",
      value: data ? String(data.unbilledDoneJobs) : "—",
      icon: Briefcase,
      color: "text-amber-500",
    },
    {
      label: "Koncepty faktur",
      value: data ? String(data.draftInvoices) : "—",
      icon: FileEdit,
      color: "text-gray-500",
    },
    {
      label: "Vystavené faktury",
      value: data ? String(data.issuedInvoices) : "—",
      icon: FileText,
      color: "text-blue-500",
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

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          {stats.map((s) => (
            <Card key={s.label}>
              <CardContent className="p-4 flex items-center gap-3">
                <s.icon className={`h-7 w-7 ${s.color}`} />
                <div>
                  <div className="text-2xl font-bold">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">
              K vyfakturování (bez DPH)
            </div>
            <div className="text-xl font-bold">
              {isLoading ? "—" : fmtKc(data?.totalToInvoiceWithoutVat, 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">
              Vystaveno tento měsíc (s DPH)
            </div>
            <div className="text-xl font-bold">
              {isLoading ? "—" : fmtKc(data?.issuedThisMonthWithVat, 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">
              Zaplaceno tento měsíc (s DPH)
            </div>
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {isLoading ? "—" : fmtKc(data?.paidThisMonthWithVat, 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {isLoading
                ? ""
                : `${data?.paidThisMonthCount ?? 0} ${invoiceNoun(data?.paidThisMonthCount ?? 0)}`}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">
              Celkem nezaplaceno (s DPH)
            </div>
            <div className="text-xl font-bold">
              {isLoading ? "—" : fmtKc(data?.unpaidTotalWithVat, 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {isLoading
                ? ""
                : `${data?.unpaidCount ?? 0} ${invoiceNoun(data?.unpaidCount ?? 0)}`}
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            !isLoading && (data?.overdueCount ?? 0) > 0
              ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30 cursor-pointer hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors"
              : ""
          }
          onClick={
            !isLoading && (data?.overdueCount ?? 0) > 0
              ? () => setLocation("/billing/invoices?status=overdue")
              : undefined
          }
        >
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              {!isLoading && (data?.overdueCount ?? 0) > 0 && (
                <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
              )}
              Po splatnosti (s DPH)
            </div>
            <div
              className={`text-xl font-bold ${
                !isLoading && (data?.overdueCount ?? 0) > 0
                  ? "text-red-700 dark:text-red-300"
                  : ""
              }`}
            >
              {isLoading ? "—" : fmtKc(data?.overdueTotalWithVat, 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {isLoading
                ? ""
                : `${data?.overdueCount ?? 0} ${invoiceNoun(data?.overdueCount ?? 0)}`}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <NavCard
          icon={Building2}
          color="text-amber-500"
          title="Nevyfakturované zakázky"
          subtitle="Vytvořte fakturu z hotových zakázek podle zákazníka"
          onClick={() => setLocation("/billing/unbilled")}
        />
        <NavCard
          icon={Inbox}
          color="text-emerald-500"
          title="Přijaté doklady"
          subtitle="Účtenky, dodací listy a přijaté faktury k přefakturaci"
          onClick={() => setLocation("/billing/documents")}
        />
        <NavCard
          icon={Sparkles}
          color="text-violet-500"
          title="Kontrola AI dokladů"
          subtitle="Doklady předvyplněné AI čekající na potvrzení, nejnižší důvěryhodnost první"
          badge={aiReviewCount}
          onClick={() => setLocation("/billing/documents/review")}
        />
        <NavCard
          icon={Mail}
          color="text-emerald-500"
          title="Import dokladů z e-mailu"
          subtitle="Stahování příloh z Gmailu / Google Workspace ke kontrole"
          onClick={() => setLocation("/billing/email-import")}
        />
        <NavCard
          icon={FileText}
          color="text-blue-500"
          title="Faktury"
          subtitle="Přehled konceptů a vystavených faktur"
          onClick={() => setLocation("/billing/invoices")}
        />
        <NavCard
          icon={Banknote}
          color="text-emerald-500"
          title="Párování plateb z banky"
          subtitle="Nahrajte výpis (KB) a spárujte platby s fakturami"
          onClick={() => setLocation("/billing/bank-import")}
        />
        <NavCard
          icon={SettingsIcon}
          color="text-gray-500"
          title="Nastavení fakturace"
          subtitle="Dodavatel, číslování, výchozí režim DPH"
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
    <Card className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={onClick}>
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
    </Card>
  );
}
