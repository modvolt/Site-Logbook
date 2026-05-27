import { Link } from "wouter";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import { Job } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, TypeBadge } from "@/components/badges";
import { Clock, MapPin, User, ChevronRight, Navigation } from "lucide-react";

export function JobCard({ job }: { job: Job }) {
  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className="hover-elevate cursor-pointer border-l-4 border-l-primary mb-3">
        <CardContent className="p-4">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-bold text-lg leading-tight truncate pr-2">{job.title}</h3>
            <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <TypeBadge type={job.type} />
            <StatusBadge status={job.status} />
          </div>

          <div className="space-y-1.5 text-sm text-muted-foreground">
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
