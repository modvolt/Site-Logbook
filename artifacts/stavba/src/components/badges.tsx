import { Check, Clock, XCircle, AlertCircle, HardHat, CalendarDays, Wrench, RefreshCw, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const JOB_STATUSES = {
  planned: { label: "Planned", color: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800", icon: Clock },
  in_progress: { label: "In Progress", color: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800", icon: AlertCircle },
  done: { label: "Done", color: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800", icon: Check },
  cancelled: { label: "Cancelled", color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", icon: XCircle },
};

export const JOB_TYPES = {
  site_visit: { label: "Site Visit", color: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800", icon: HardHat },
  consultation: { label: "Consultation", color: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800", icon: CalendarDays },
  planned_work: { label: "Planned Work", color: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800", icon: Wrench },
  service_call: { label: "Service Call", color: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800", icon: AlertCircle },
  change: { label: "Change Request", color: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800", icon: RefreshCw },
  other: { label: "Other", color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", icon: MoreHorizontal },
};

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const config = JOB_STATUSES[status as keyof typeof JOB_STATUSES] || JOB_STATUSES.planned;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`font-medium ${config.color} ${className}`}>
      <Icon className="w-3 h-3 mr-1" />
      {config.label}
    </Badge>
  );
}

export function TypeBadge({ type, className = "" }: { type: string; className?: string }) {
  const config = JOB_TYPES[type as keyof typeof JOB_TYPES] || JOB_TYPES.other;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`font-medium ${config.color} ${className}`}>
      <Icon className="w-3 h-3 mr-1" />
      {config.label}
    </Badge>
  );
}
