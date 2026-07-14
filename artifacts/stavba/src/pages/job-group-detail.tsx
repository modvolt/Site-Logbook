import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FileText,
  Link2,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { useCreateQuoteJobGroupInvoiceDraft } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchJson,
  formatDate,
  formatKc,
  materialLineTotal,
  type JobGroupDetail as JobGroupDetailType,
  type JobListItem,
} from "@/lib/job-groups-api";

function jobLabel(
  job: Pick<JobListItem, "jobNumber" | "id" | "title">,
): string {
  return `#${job.jobNumber ?? job.id} ${job.title}`;
}

export default function JobGroupDetail() {
  const params = useParams();
  const id = Number(params.id || 0);
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { can } = useAuth();
  const [jobFilter, setJobFilter] = useState("");
  const [selectedJobIds, setSelectedJobIds] = useState<Set<number>>(new Set());
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [extraJobIds, setExtraJobIds] = useState<Set<number>>(new Set());
  const [labourBillingMode, setLabourBillingMode] = useState<
    "job_price" | "recorded_time" | "none"
  >("job_price");

  const detailQuery = useQuery({
    queryKey: ["job-groups", id],
    queryFn: () => fetchJson<JobGroupDetailType>(`/api/job-groups/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });

  const jobsQuery = useQuery({
    queryKey: ["jobs-for-group-picker"],
    queryFn: () => fetchJson<JobListItem[]>("/api/jobs"),
  });

  const assignMutation = useMutation({
    mutationFn: (jobIds: number[]) =>
      fetchJson<{ assigned: number }>(`/api/job-groups/${id}/jobs`, {
        method: "POST",
        body: JSON.stringify({ jobIds }),
      }),
    onSuccess: () => {
      setSelectedJobIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["job-groups"] });
      queryClient.invalidateQueries({ queryKey: ["job-groups", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs-for-group-picker"] });
      toast.success("Zakázky byly přiřazeny.");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Zakázky se nepodařilo přiřadit.",
      ),
  });

  const removeMutation = useMutation({
    mutationFn: (jobId: number) =>
      fetchJson<void>(`/api/job-groups/${id}/jobs/${jobId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-groups"] });
      queryClient.invalidateQueries({ queryKey: ["job-groups", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs-for-group-picker"] });
      toast.success("Zakázka byla odebrána z akce.");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Zakázku se nepodařilo odebrat.",
      ),
  });

  const createInvoice = useCreateQuoteJobGroupInvoiceDraft();

  const group = detailQuery.data;
  const assignedIds = new Set(group?.jobs.map((job) => job.id) ?? []);
  const pickerJobs = useMemo(() => {
    const q = jobFilter.trim().toLowerCase();
    return (jobsQuery.data ?? [])
      .filter((job) => job.groupId == null || job.groupId === id)
      .filter((job) => !assignedIds.has(job.id))
      .filter((job) => {
        if (!q) return true;
        return [
          job.title,
          String(job.jobNumber ?? job.id),
          job.customerCompanyName ?? "",
          job.address ?? "",
          job.clientSite ?? "",
        ].some((value) => value.toLowerCase().includes(q));
      })
      .slice(0, 80);
  }, [assignedIds, id, jobFilter, jobsQuery.data]);

  function toggleSelected(jobId: number) {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function handleAssign() {
    const ids = Array.from(selectedJobIds);
    if (ids.length === 0) {
      toast.error("Vyberte alespoň jednu zakázku.");
      return;
    }
    assignMutation.mutate(ids);
  }

  if (detailQuery.isLoading) {
    return (
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (!group) {
    return <div className="p-8 text-center">Akce nenalezena.</div>;
  }

  const totalMaterials = group.jobs.reduce(
    (sum, job) =>
      sum +
      job.materials.reduce(
        (inner, material) => inner + materialLineTotal(material),
        0,
      ),
    0,
  );
  const totalHours = group.jobs.reduce(
    (sum, job) => sum + (job.hoursSpent ?? 0),
    0,
  );
  const unfinishedJobs = group.jobs.filter(
    (job) => !["done", "cancelled"].includes(job.status),
  );
  const selectableExtraJobs = group.jobs.filter(
    (job) => job.id !== group.sourceQuoteJobId && job.status === "done",
  );

  function toggleExtraJob(jobId: number) {
    setExtraJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function handleCreateInvoice() {
    if (!group) return;
    createInvoice.mutate(
      {
        id: group.id,
        data: {
          extraJobIds: Array.from(extraJobIds),
          labourBillingMode,
          workGrouping: "summary",
        },
      },
      {
        onSuccess: (invoice) => {
          setInvoiceDialogOpen(false);
          queryClient.invalidateQueries({ queryKey: ["job-groups", id] });
          toast.success("Koncept faktury byl vytvořen.");
          setLocation(`/billing/invoices/${invoice.id}/edit`);
        },
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Koncept faktury se nepodařilo vytvořit.",
          ),
      },
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <Button variant="ghost" asChild className="mb-2 -ml-3">
            <Link href="/job-groups">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Akce
            </Link>
          </Button>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight truncate">
              {group.name}
            </h1>
            <Badge variant="outline">
              {group.status === "closed" ? "Uzavřená" : "Otevřená"}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            {group.address || group.customerCompanyName || "Bez adresy"} ·{" "}
            {formatDate(group.dateFrom)} - {formatDate(group.dateTo)}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {group.sourceQuoteId != null &&
            can("billing.view") &&
            can("billing.manage") &&
            (group.sourceInvoiceId != null ? (
              <Button variant="outline" asChild>
                <Link href={`/billing/invoices/${group.sourceInvoiceId}`}>
                  <ReceiptText className="h-4 w-4 mr-2" />
                  Otevřít fakturu
                </Link>
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setInvoiceDialogOpen(true)}
                disabled={unfinishedJobs.length > 0 || group.jobs.length === 0}
                title={
                  unfinishedJobs.length > 0
                    ? "Nejprve dokončete nebo zrušte všechny zakázky v akci."
                    : undefined
                }
              >
                <ReceiptText className="h-4 w-4 mr-2" />
                Vytvořit fakturu
              </Button>
            ))}
          {group.sourceInvoiceId == null && (
            <Button variant="outline" asChild>
              <Link
                href={`/jobs/new?groupId=${group.id}&customerId=${group.customerId ?? ""}&date=${group.dateTo ?? group.dateFrom ?? ""}`}
              >
                <Plus className="h-4 w-4 mr-2" />
                Přidat zakázku
              </Link>
            </Button>
          )}
          <Button asChild>
            <Link href={`/job-groups/${group.id}/list`}>
              <FileText className="h-4 w-4 mr-2" />
              Společný zakázkový list
            </Link>
          </Button>
        </div>
      </div>

      {group.sourceQuoteId != null && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          <ReceiptText className="h-4 w-4 shrink-0" />
          Realizace nabídky
          <Link
            href={`/quotes/${group.sourceQuoteId}`}
            className="font-medium underline underline-offset-2"
          >
            {group.sourceQuoteNumber ?? `#${group.sourceQuoteId}`} ·{" "}
            {group.sourceQuoteTitle ?? group.name}
          </Link>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Zakázky v akci</div>
          <div className="text-2xl font-semibold">{group.jobs.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Celkem hodin</div>
          <div className="text-2xl font-semibold">
            {totalHours.toLocaleString("cs-CZ")}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Materiál celkem</div>
          <div className="text-2xl font-semibold">
            {formatKc(totalMaterials)}
          </div>
        </div>
      </div>

      <section className="rounded-lg border bg-card">
        <div className="p-4 border-b flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-semibold">Zakázky v akci</h2>
            <p className="text-sm text-muted-foreground">
              Tyto zakázky budou zahrnuté ve společném listu.
            </p>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Zakázka</TableHead>
              <TableHead>Datum</TableHead>
              <TableHead>Hodiny</TableHead>
              <TableHead>Materiál</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.jobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground py-8"
                >
                  Zatím nejsou přiřazené žádné zakázky.
                </TableCell>
              </TableRow>
            ) : (
              group.jobs.map((job) => {
                const materialTotal = job.materials.reduce(
                  (sum, material) => sum + materialLineTotal(material),
                  0,
                );
                return (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link
                        href={`/jobs/${job.id}`}
                        className="font-medium hover:underline"
                      >
                        {jobLabel(job)}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {job.address || job.clientSite || ""}
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(job.date)}</TableCell>
                    <TableCell>
                      {(job.hoursSpent ?? 0).toLocaleString("cs-CZ")}
                    </TableCell>
                    <TableCell>{formatKc(materialTotal)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeMutation.mutate(job.id)}
                        disabled={
                          removeMutation.isPending ||
                          group.sourceInvoiceId != null
                        }
                        title={
                          group.sourceInvoiceId != null
                            ? "Složení fakturované akce nelze měnit."
                            : "Odebrat zakázku z akce"
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      {group.sourceInvoiceId == null && (
        <section className="rounded-lg border bg-card p-4 space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-semibold">Přidat zakázky</h2>
              <p className="text-sm text-muted-foreground">
                Zobrazují se zakázky, které ještě nejsou v jiné akci.
              </p>
            </div>
            <Button
              onClick={handleAssign}
              disabled={assignMutation.isPending || selectedJobIds.size === 0}
            >
              <Link2 className="h-4 w-4 mr-2" />
              Přidat vybrané ({selectedJobIds.size})
            </Button>
          </div>
          <div className="relative">
            <Input
              value={jobFilter}
              onChange={(event) => setJobFilter(event.target.value)}
              placeholder="Filtrovat podle čísla, názvu, zákazníka nebo adresy"
            />
            {jobFilter && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setJobFilter("")}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {jobsQuery.isLoading ? (
              <Skeleton className="h-24 w-full md:col-span-2" />
            ) : pickerJobs.length === 0 ? (
              <div className="text-sm text-muted-foreground rounded-md border border-dashed p-6 md:col-span-2 text-center">
                Žádné volné zakázky.
              </div>
            ) : (
              pickerJobs.map((job) => (
                <label
                  key={job.id}
                  className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    checked={selectedJobIds.has(job.id)}
                    onChange={() => toggleSelected(job.id)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium truncate">
                      {jobLabel(job)}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {formatDate(job.date)} ·{" "}
                      {job.customerCompanyName ||
                        job.address ||
                        job.clientSite ||
                        "Bez zákazníka"}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
        </section>
      )}

      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Faktura z celé akce</DialogTitle>
            <DialogDescription>
              Základ faktury vznikne z uložených položek přijaté nabídky. Níže
              vyberte pouze skutečně schválené vícepráce.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="font-medium">
                {group.sourceQuoteNumber ?? `Nabídka #${group.sourceQuoteId}`}
              </div>
              <div className="text-muted-foreground">
                Ceny a množství se zkopírují do konceptu jako finanční snapshot.
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">
                Schválené vícepráce
              </div>
              {selectableExtraJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Akce nemá další dokončené zakázky. Faktura bude obsahovat jen
                  položky nabídky.
                </p>
              ) : (
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {selectableExtraJobs.map((job) => (
                    <label
                      key={job.id}
                      className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-primary"
                        checked={extraJobIds.has(job.id)}
                        onChange={() => toggleExtraJob(job.id)}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {jobLabel(job)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {formatDate(job.date)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {extraJobIds.size > 0 && (
              <div>
                <div className="mb-2 text-sm font-medium">
                  Jak účtovat práci víceprací
                </div>
                <div className="inline-flex flex-wrap rounded-md border p-1">
                  {(
                    [
                      ["job_price", "Cena zakázky"],
                      ["recorded_time", "Skutečný čas"],
                      ["none", "Bez práce"],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={
                        labourBillingMode === value ? "default" : "ghost"
                      }
                      onClick={() => setLabourBillingMode(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Spotřebovaný oceněný materiál vybraných víceprací se přidá
                  automaticky. Koncept lze před vystavením zkontrolovat.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInvoiceDialogOpen(false)}
            >
              Zrušit
            </Button>
            <Button
              type="button"
              onClick={handleCreateInvoice}
              disabled={createInvoice.isPending}
            >
              {createInvoice.isPending ? "Vytvářím…" : "Vytvořit koncept"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
