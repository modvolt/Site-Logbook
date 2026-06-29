import { AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

function tryHeaders(h: unknown): string | undefined {
  if (h instanceof Headers) {
    const id = h.get("x-request-id") ?? h.get("X-Request-Id");
    return id ?? undefined;
  }
  if (h && typeof h === "object") {
    const ho = h as Record<string, unknown>;
    const id = ho["x-request-id"] ?? ho["X-Request-Id"];
    return typeof id === "string" && id ? id : undefined;
  }
  return undefined;
}

function tryData(d: unknown): string | undefined {
  if (!d || typeof d !== "object") return undefined;
  const o = d as Record<string, unknown>;
  const rid = o.requestId ?? o.request_id;
  return typeof rid === "string" && rid ? rid : undefined;
}

function extractRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;

  // ApiError: top-level e.headers is a Headers instance
  const direct = tryHeaders(e.headers);
  if (direct) return direct;

  // ApiError: e.response.headers is also a Headers instance
  const response = e.response as Record<string, unknown> | undefined;
  if (response) {
    const fromResponse = tryHeaders(response.headers);
    if (fromResponse) return fromResponse;

    // e.response.data.requestId
    const fromData = tryData(response.data);
    if (fromData) return fromData;
  }

  // e.data.requestId
  return tryData(e.data);
}

interface QueryErrorStateProps {
  title?: string;
  description?: string;
  requestId?: string;
  error?: unknown;
  onRetry?: () => void;
  /**
   * Optional path shown only to admins (e.g. "/admin/health").
   * Renders a small "Diagnostika" link below the retry button.
   */
  diagnosticsLink?: string;
  /**
   * Optional slot rendered below the error UI.
   * Use to preserve in-progress form content during an error.
   */
  children?: React.ReactNode;
}

export function QueryErrorState({
  title = "Nepodařilo se načíst data",
  description = "Zkontrolujte připojení a zkuste to znovu.",
  requestId,
  error,
  onRetry,
  diagnosticsLink,
  children,
}: QueryErrorStateProps) {
  const rid = requestId ?? extractRequestId(error);
  return (
    <div role="alert" className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
      <AlertCircle className="h-10 w-10 text-destructive/60" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-sm text-center max-w-xs">{description}</p>
      {rid && (
        <p className="text-xs font-mono text-muted-foreground/70">ID: {rid}</p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3 mt-1">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-2">
            <RefreshCw className="h-4 w-4" /> Zkusit znovu
          </Button>
        )}
        {diagnosticsLink && (
          <Link href={diagnosticsLink}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ExternalLink className="h-3.5 w-3.5" /> Diagnostika
            </Button>
          </Link>
        )}
      </div>
      {children && (
        <div className="mt-4 w-full max-w-md opacity-60 pointer-events-none select-none">
          {children}
        </div>
      )}
    </div>
  );
}
