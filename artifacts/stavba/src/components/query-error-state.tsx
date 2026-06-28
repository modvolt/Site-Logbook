import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QueryErrorStateProps {
  title?: string;
  description?: string;
  requestId?: string;
  onRetry?: () => void;
}

export function QueryErrorState({
  title = "Nepodařilo se načíst data",
  description = "Zkontrolujte připojení a zkuste to znovu.",
  requestId,
  onRetry,
}: QueryErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3"
    >
      <AlertCircle className="h-10 w-10 text-destructive/60" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-sm text-center max-w-xs">{description}</p>
      {requestId && (
        <p className="text-xs font-mono text-muted-foreground/70">ID: {requestId}</p>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 gap-2">
          <RefreshCw className="h-4 w-4" /> Zkusit znovu
        </Button>
      )}
    </div>
  );
}
