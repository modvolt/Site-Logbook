import { format } from "date-fns";
import { cs } from "date-fns/locale";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { useOfflineQueue, opTypeLabel } from "@/hooks/use-offline-queue";
import { canManuallyRetryOfflineFailure } from "@/lib/offline-retry";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onClose: () => void;
}

function failureLabel(kind: string | undefined): string | null {
  switch (kind) {
    case "ambiguous": return "Výsledek je nejasný – nejprve ověřte stav na serveru.";
    case "conflict": return "Data se mezitím změnila – zkontrolujte aktuální stav.";
    case "auth": return "Přihlášení nebo oprávnění se změnilo.";
    case "transient": return "Automatické pokusy byly vyčerpány.";
    case "permanent": return "Požadavek vyžaduje opravu nebo nové zadání.";
    default: return null;
  }
}

export function OfflineFailedDialog({ open, onClose }: Props) {
  const { failedOps, retryOp, discardOp, discardAll } = useOfflineQueue();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            Chybné offline akce
          </DialogTitle>
        </DialogHeader>

        {failedOps.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Žádné chybné akce.
          </p>
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto py-1">
            {failedOps.map((op) => (
              <div
                key={op.id}
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{opTypeLabel(op.type)}</p>
                    <p className="text-xs text-muted-foreground">
                      Zakázka #{op.jobId} ·{" "}
                      {format(new Date(op.createdAt), "d. M. yyyy HH:mm", { locale: cs })}
                      {" · "}{op.attempts} {op.attempts === 1 ? "pokus" : "pokusů"}
                    </p>
                    {op.errorMessage && (
                      <p className="text-xs text-destructive mt-1 break-words">
                        {op.errorMessage}
                      </p>
                    )}
                    {failureLabel(op.failureKind) && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mt-1">
                        {failureLabel(op.failureKind)}
                      </p>
                    )}
                  </div>
                </div>
                {op.type === "add_material" && typeof op.payload.name === "string" && op.payload.name && (
                  <p className="text-xs text-muted-foreground">
                    Materiál: <span className="font-medium">{op.payload.name}</span>
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retryOp(op.id)}
                    disabled={!canManuallyRetryOfflineFailure(op.failureKind)}
                    className="h-8 text-xs"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" /> Opakovat
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => discardOp(op.id)}
                    className="h-8 text-xs text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3 mr-1" /> Zahodit
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {failedOps.length > 1 && (
          <div className="pt-2 border-t flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              {failedOps.length} chybných akcí
            </p>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { void discardAll(); onClose(); }}
              className="h-8 text-xs"
            >
              <Trash2 className="w-3 h-3 mr-1" /> Zahodit vše
            </Button>
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Zavřít
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
