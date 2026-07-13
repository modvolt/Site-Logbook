import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, QrCode, RefreshCw, ShieldCheck, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { switchboardFetch, type Switchboard, type SwitchboardLabel } from "@/lib/switchboards-api";

export function SwitchboardLabels({ board }: { board: Switchboard }) {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const key = ["switchboard-labels", board.id];
  const { data = [] } = useQuery({
    queryKey: key,
    queryFn: () => switchboardFetch<SwitchboardLabel[]>(`/api/switchboards/${board.id}/labels`),
  });
  const rotate = useMutation({
    mutationFn: () => switchboardFetch<{ publicUrl: string }>(`/api/switchboards/${board.id}/qr/rotate`, { method: "POST", body: JSON.stringify({ expiresAt: null }) }),
    onSuccess: (result) => {
      setLastUrl(result.publicUrl);
      void qc.invalidateQueries({ queryKey: ["switchboards", board.id] });
      toast({ title: "QR přístup byl aktivován", description: "Starší QR token byl zneplatněn." });
    },
    onError: (error) => toast({ variant: "destructive", title: "QR nelze aktivovat", description: error.message }),
  });
  const deactivate = useMutation({
    mutationFn: () => switchboardFetch(`/api/switchboards/${board.id}/qr/deactivate`, { method: "POST" }),
    onSuccess: () => {
      setLastUrl(null);
      void qc.invalidateQueries({ queryKey: ["switchboards", board.id] });
      toast({ title: "QR přístup byl deaktivován" });
    },
  });
  const generate = useMutation({
    mutationFn: () => switchboardFetch<SwitchboardLabel>(`/api/switchboards/${board.id}/labels/generate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast({ title: "Nová verze štítku byla vytvořena" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Štítek nelze vytvořit", description: error.message }),
  });
  const approve = useMutation({
    mutationFn: (labelId: number) => switchboardFetch(`/api/switchboards/${board.id}/labels/${labelId}/approve`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast({ title: "Typový štítek byl schválen" });
    },
  });

  return (
    <section className="mt-5 border-y bg-card">
      <div className="p-4 border-b flex items-center gap-3">
        <Tag className="h-5 w-5 text-cyan-600" />
        <div className="flex-1">
          <h2 className="font-semibold">QR a typové štítky</h2>
          <p className="text-xs text-muted-foreground">Verzované PDF 100 × 60 mm a PNG 300 DPI</p>
        </div>
      </div>
      <div className="p-4 border-b flex gap-2 flex-wrap items-center">
        <div className={`text-sm mr-auto ${board.qrEnabled ? "text-emerald-600" : "text-muted-foreground"}`}>
          <QrCode className="h-4 w-4 inline mr-1" />
          {board.qrEnabled ? `QR aktivní · ${board.qrTokenPrefix}…` : "QR není aktivní"}
        </div>
        {can("switchboards.qr.manage") && (
          <>
            <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              <RefreshCw className="h-4 w-4 mr-1" />{board.qrEnabled ? "Rotovat QR" : "Aktivovat QR"}
            </Button>
            {board.qrEnabled && (
              <>
                <Button size="icon" variant="outline" asChild title="Stáhnout samostatný QR kód">
                  <a href={`/api/switchboards/${board.id}/qr/png`}><Download className="h-4 w-4" /></a>
                </Button>
                <Button size="sm" variant="outline" onClick={() => deactivate.mutate()}>Deaktivovat</Button>
              </>
            )}
          </>
        )}
        {can("switchboards.labels.generate") && (
          <Button size="sm" disabled={!board.qrEnabled || generate.isPending} onClick={() => generate.mutate()}>
            Vygenerovat štítek
          </Button>
        )}
      </div>
      {lastUrl && (
        <div className="p-3 border-b bg-amber-50 dark:bg-amber-950/20 text-xs break-all">
          <strong>Nový veřejný odkaz:</strong>{" "}
          <a className="text-blue-600 underline" href={lastUrl} target="_blank" rel="noreferrer">{lastUrl}</a>
        </div>
      )}
      <div className="divide-y">
        {data.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">Zatím nebyl vytvořen žádný štítek.</div>
        ) : data.map((label) => (
          <div key={label.id} className="p-4 flex items-center gap-3">
            <div className="flex-1">
              <div className="font-medium">Typový štítek · verze {label.version}</div>
              <div className="text-xs text-muted-foreground">
                {label.status === "approved" ? "Schválený" : "Návrh ke kontrole"} · generátor {label.generatorVersion}
              </div>
            </div>
            {label.status !== "approved" && can("switchboards.labels.approve") && (
              <Button size="sm" variant="outline" onClick={() => approve.mutate(label.id)}>
                <ShieldCheck className="h-4 w-4 mr-1" />Schválit
              </Button>
            )}
            <Button size="icon" variant="ghost" asChild title="PNG">
              <a href={`/api/switchboards/${board.id}/labels/${label.id}/png`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
            </Button>
            <Button size="icon" variant="ghost" asChild title="PDF">
              <a href={`/api/switchboards/${board.id}/labels/${label.id}/pdf`}><Download className="h-4 w-4" /></a>
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
