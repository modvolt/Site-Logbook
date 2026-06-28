import { useState } from "react";
import {
  useListPpeHandoverEvents,
  getListPpeHandoverEventsQueryKey,
} from "@workspace/api-client-react";
import { History, ChevronDown, ChevronUp, PenLine, FileText, Image } from "lucide-react";

const EVENT_LABELS: Record<string, string> = {
  signed: "Podepsáno zaměstnancem",
  pdf_downloaded: "Stažen protokol PDF",
  signature_viewed: "Zobrazena fotografie podpisu",
};

const EVENT_ICONS: Record<string, React.ReactNode> = {
  signed: <PenLine className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />,
  pdf_downloaded: <FileText className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400" />,
  signature_viewed: <Image className="h-3 w-3 shrink-0 text-purple-600 dark:text-purple-400" />,
};

export function PpeEventHistory({ assignmentId }: { assignmentId: number }) {
  const [open, setOpen] = useState(false);

  const { data: events, isLoading } = useListPpeHandoverEvents(assignmentId, {
    query: {
      queryKey: getListPpeHandoverEventsQueryKey(assignmentId),
      enabled: open,
    },
  });

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <History className="h-3 w-3" />
        Historie protokolu
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div className="mt-2 pl-3 border-l-2 border-muted space-y-2.5">
          {isLoading ? (
            <p className="text-xs text-muted-foreground py-0.5">Načítám…</p>
          ) : !events || events.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-0.5">Žádné záznamy.</p>
          ) : (
            events.map((ev) => (
              <div key={ev.id} className="flex items-start gap-1.5 text-xs">
                <span className="mt-0.5">{EVENT_ICONS[ev.eventType] ?? <History className="h-3 w-3 shrink-0 text-muted-foreground" />}</span>
                <div>
                  <span className="font-medium">{EVENT_LABELS[ev.eventType] ?? ev.eventType}</span>
                  {ev.actorName && (
                    <span className="text-muted-foreground"> · {ev.actorName}</span>
                  )}
                  <div className="text-muted-foreground">
                    {new Date(ev.createdAt).toLocaleString("cs-CZ")}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
