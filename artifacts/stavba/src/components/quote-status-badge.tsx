import { Badge } from "@/components/ui/badge";
import { Clock, Send, Check, X, AlertCircle } from "lucide-react";

export const QUOTE_STATUSES: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  draft: {
    label: "Koncept",
    color: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    icon: Clock,
  },
  sent: {
    label: "Odeslaná",
    color: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
    icon: Send,
  },
  accepted: {
    label: "Přijatá",
    color: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800",
    icon: Check,
  },
  rejected: {
    label: "Odmítnutá",
    color: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
    icon: X,
  },
  expired: {
    label: "Expirovaná",
    color: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800",
    icon: AlertCircle,
  },
};

export function QuoteStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const config = QUOTE_STATUSES[status] ?? QUOTE_STATUSES.draft;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`font-medium text-xs ${config.color} ${className}`}>
      <Icon className="w-3 h-3 mr-1" />
      {config.label}
    </Badge>
  );
}
