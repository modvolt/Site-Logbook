import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircuitBoard, MapPin, Plus, Loader2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { SWITCHBOARD_STATUS_LABELS, switchboardFetch, type Switchboard } from "@/lib/switchboards-api";

export function SwitchboardsSection({ jobId }: { jobId: number }) {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [internalName, setInternalName] = useState("");
  const [designation, setDesignation] = useState("");
  const [location, setLocation] = useState("");
  const queryKey = ["switchboards", { jobId }];
  const { data = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => switchboardFetch<Switchboard[]>(`/api/switchboards?jobId=${jobId}`),
    enabled: can("switchboards.view"),
  });
  const create = useMutation({
    mutationFn: () => switchboardFetch<Switchboard>("/api/switchboards", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        internalName: internalName.trim(),
        designation: designation.trim(),
        installationLocation: location.trim() || null,
      }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setOpen(false); setInternalName(""); setDesignation(""); setLocation("");
      toast({ title: "Rozvaděč byl založen" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Založení selhalo", description: error.message }),
  });

  if (!can("switchboards.view")) return null;
  return (
    <section className="border-y bg-card">
      <div className="px-4 py-3 flex items-center gap-3">
        <CircuitBoard className="h-5 w-5 text-cyan-600" />
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Rozvaděče</h2>
          <p className="text-xs text-muted-foreground">{isLoading ? "Načítám…" : `${data.length} u této zakázky`}</p>
        </div>
        {can("switchboards.create") && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Přidat
          </Button>
        )}
      </div>
      {data.length > 0 && (
        <div className="border-t divide-y">
          {data.map((board) => (
            <Link key={board.id} href={`/switchboards/${board.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60">
              <div className="h-9 w-9 shrink-0 grid place-items-center border rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-950/30">
                <CircuitBoard className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{board.designation}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span>{board.internalName}</span>
                  {board.installationLocation && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{board.installationLocation}</span>}
                  <span>{SWITCHBOARD_STATUS_LABELS[board.status] ?? board.status}</span>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nový rozvaděč</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="board-designation">Označení rozvaděče</Label><Input id="board-designation" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="R1" /></div>
            <div className="space-y-1.5"><Label htmlFor="board-name">Interní název</Label><Input id="board-name" value={internalName} onChange={(e) => setInternalName(e.target.value)} placeholder="Hlavní rozvaděč" /></div>
            <div className="space-y-1.5"><Label htmlFor="board-location">Místo instalace</Label><Input id="board-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="1. NP, technická místnost" /></div>
            <Button className="w-full" disabled={!designation.trim() || !internalName.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Založit rozvaděč
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
