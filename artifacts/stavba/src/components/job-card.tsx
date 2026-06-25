import { Link } from "wouter";
import { format, differenceInDays } from "date-fns";
import { cs } from "date-fns/locale";
import { Job } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, TypeBadge } from "@/components/badges";
import { Clock, MapPin, User, ChevronRight, Navigation, Timer, AlertCircle, FileText, Package, CircleDollarSign, CheckCircle2, Tag } from "lucide-react";
import { isJobFinished } from "@/lib/job-sort";

function formatCzk(amount: number): string {
  if (amount >= 1000) return `${Math.round(amount / 100) / 10} tis. Kč`;
  return `${Math.round(amount)} Kč`;
}

function JobSignalBadges({ job }: { job: Job }) {
  const isActive = job.status === "planned" || job.status === "in_progress";
  const isDone = job.status === "done";

  const badges: { label: string; icon: React.ReactNode; className: string; key: string }[] = [];

  if (isDone && !(job as any).billingLinked) {
    badges.push({
      key: "ready",
      label: "K fakturaci",
      icon: <CircleDollarSign className="w-3 h-3" />,
      className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    });
  }

  if (isDone && (job as any).billingLinked) {
    badges.push({
      key: "billed",
      label: "Vyfakturováno",
      icon: <CheckCircle2 className="w-3 h-3" />,
      className: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    });
  }

  if (isActive && !job.customerId) {
    badges.push({
      key: "no-customer",
      label: "Chybí zákazník",
      icon: <AlertCircle className="w-3 h-3" />,
      className: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    });
  }

  if (isActive && job.price == null) {
    badges.push({
      key: "no-price",
      label: "Chybí cena",
      icon: <AlertCircle className="w-3 h-3" />,
      className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    });
  }

  if (job.status === "in_progress") {
    const days = differenceInDays(new Date(), new Date(job.date));
    if (days >= 7) {
      badges.push({
        key: "stale",
        label: `${days} dní`,
        icon: <Clock className="w-3 h-3" />,
        className: days >= 14
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
      });
    }
  }

  if (job.attachmentCount != null && job.attachmentCount > 0) {
    badges.push({
      key: "docs",
      label: `Doklady: ${job.attachmentCount}`,
      icon: <FileText className="w-3 h-3" />,
      className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    });
  }

  const materialTotalCost = (job as any).materialTotalCost as number | null;
  if (materialTotalCost != null && materialTotalCost > 0) {
    badges.push({
      key: "material-cost",
      label: `Mat: ${formatCzk(materialTotalCost)}`,
      icon: <Package className="w-3 h-3" />,
      className: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    });
  } else if (job.materialCount != null && job.materialCount > 0) {
    badges.push({
      key: "material-count",
      label: `Materiál: ${job.materialCount}`,
      icon: <Package className="w-3 h-3" />,
      className: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    });
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {badges.map(b => (
        <span
          key={b.key}
          className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full ${b.className}`}
        >
          {b.icon}
          {b.label}
        </span>
      ))}
    </div>
  );
}

export function JobCard({ job }: { job: Job }) {
  const finished = isJobFinished(job.status);
  const shortName = (job as any).shortName as string | null;
  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className={`hover-elevate cursor-pointer border-l-4 mb-3 transition-all ${
        finished
          ? "border-l-muted-foreground/40 bg-muted/40 opacity-65 saturate-50 hover:opacity-90 hover:saturate-100"
          : "border-l-primary"
      }`}>
        <CardContent className="p-4">
          <div className="flex justify-between items-start mb-2">
            <div className="flex-1 min-w-0 pr-2">
              {shortName && (
                <div className="flex items-center gap-1 mb-0.5">
                  <Tag className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">{shortName}</span>
                </div>
              )}
              <h3 className="font-bold text-lg leading-tight truncate">{job.title}</h3>
            </div>
            <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
          </div>

          <div className="flex flex-wrap gap-2 mb-2 items-center">
            <TypeBadge type={job.type} />
            <StatusBadge status={job.status} />
            {job.hoursSpent != null && Number(job.hoursSpent) > 0 && (
              <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                <Timer className="w-3 h-3" /> {Number(job.hoursSpent).toFixed(2)} h
              </span>
            )}
          </div>

          <JobSignalBadges job={job} />

          <div className="space-y-1.5 text-sm text-muted-foreground mt-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span>
                {format(new Date(job.date), "d.M.yyyy", { locale: cs })}
                {job.startTime && ` • ${job.startTime}`}
                {job.endTime && ` – ${job.endTime}`}
              </span>
            </div>

            {job.clientSite && (
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                <span className="truncate">{job.clientSite}</span>
              </div>
            )}

            {(job as any).address && (
              <div className="flex items-center gap-2">
                <Navigation className="w-4 h-4 text-blue-500 shrink-0" />
                <a
                  href={`https://waze.com/ul?q=${encodeURIComponent((job as any).address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="text-blue-500 hover:underline truncate"
                >
                  {(job as any).address}
                </a>
              </div>
            )}

            {job.assignedPersonName && (
              <div className="flex items-center gap-2">
                <User className="w-4 h-4" />
                <span className="truncate">{job.assignedPersonName}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
