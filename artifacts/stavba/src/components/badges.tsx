import { Check, Clock, XCircle, AlertCircle, HardHat, CalendarDays, Wrench, RefreshCw, MoreHorizontal, ShieldCheck, Receipt, FileEdit, FileText, Send, CircleDollarSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const JOB_STATUSES = {
  planned: { label: "Naplánováno", color: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800", icon: Clock },
  in_progress: { label: "Probíhá", color: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800", icon: AlertCircle },
  done: { label: "Hotovo", color: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800", icon: Check },
  vyfakturovano: { label: "Vyfakturováno", color: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800", icon: Receipt },
  cancelled: { label: "Zrušeno", color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", icon: XCircle },
};

export const JOB_TYPES = {
  site_visit: { label: "Výjezd", color: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800", icon: HardHat },
  consultation: { label: "Konzultace", color: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800", icon: CalendarDays },
  planned_work: { label: "Plánovaná práce", color: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800", icon: Wrench },
  service_call: { label: "Servisní výjezd", color: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800", icon: AlertCircle },
  change: { label: "Vícepráce", color: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800", icon: RefreshCw },
  revize: { label: "Revize", color: "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-800", icon: ShieldCheck },
  other: { label: "Ostatní", color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", icon: MoreHorizontal },
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

export const INVOICE_STATUSES = {
  draft: { label: "Koncept", color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", icon: FileEdit },
  issued: { label: "Vystaveno", color: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800", icon: FileText },
  sent: { label: "Odesláno", color: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800", icon: Send },
  paid: { label: "Zaplaceno", color: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800", icon: CircleDollarSign },
  cancelled: { label: "Stornováno", color: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800", icon: XCircle },
};

export function InvoiceStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const config = INVOICE_STATUSES[status as keyof typeof INVOICE_STATUSES] || INVOICE_STATUSES.draft;
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
