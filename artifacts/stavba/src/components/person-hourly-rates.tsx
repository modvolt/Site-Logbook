import { useState } from "react";
import { Banknote, Plus, X, AlertTriangle } from "lucide-react";
import {
  getListPersonHourlyRatesQueryKey,
  useCreatePersonHourlyRate,
  useListPersonHourlyRates,
  useVoidPersonHourlyRate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: number | null) => value == null ? "Skryto" : `${value.toLocaleString("cs-CZ")} Kč/h`;

export function PersonHourlyRates({ personId }: { personId: number }) {
  const { can } = useAuth();
  const canCost = can("rates.cost.view");
  const canSale = can("rates.sale.view");
  const canManage = can("rates.manage") && canCost && canSale;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const key = getListPersonHourlyRatesQueryKey(personId);
  const { data: rates } = useListPersonHourlyRates(personId, {
    query: { queryKey: key, enabled: canCost || canSale },
  });
  const create = useCreatePersonHourlyRate();
  const voidRate = useVoidPersonHourlyRate();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ validFrom: today(), costRate: "", saleRate: "", reason: "" });
  const [voidingId, setVoidingId] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");

  if (!canCost && !canSale) return null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const submit = () => {
    const costRate = Number(form.costRate.replace(",", "."));
    const saleRate = Number(form.saleRate.replace(",", "."));
    if (!form.validFrom || !Number.isFinite(costRate) || costRate < 0 || !Number.isFinite(saleRate) || saleRate < 0 || form.reason.trim().length < 3) return;
    create.mutate({ id: personId, data: { validFrom: form.validFrom, costRate, saleRate, reason: form.reason.trim() } }, {
      onSuccess: () => {
        void refresh();
        setAdding(false);
        setForm({ validFrom: today(), costRate: "", saleRate: "", reason: "" });
        toast({ title: "Nová sazba byla uložena" });
      },
      onError: () => toast({ title: "Sazbu se nepodařilo uložit", variant: "destructive" }),
    });
  };

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg flex items-center gap-2"><Banknote className="h-5 w-5 text-emerald-600" /> Hodinové sazby</CardTitle>
          {canManage && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> Nová sazba</Button>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && (
          <div className="grid gap-2 border-b pb-4 sm:grid-cols-2">
            <label className="text-xs font-medium">Platí od<Input type="date" className="mt-1" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
            <label className="text-xs font-medium">Nákladová sazba Kč/h<Input type="number" min="0" step="0.01" className="mt-1" value={form.costRate} onChange={(e) => setForm({ ...form, costRate: e.target.value })} /></label>
            <label className="text-xs font-medium">Prodejní sazba Kč/h<Input type="number" min="0" step="0.01" className="mt-1" value={form.saleRate} onChange={(e) => setForm({ ...form, saleRate: e.target.value })} /></label>
            <label className="text-xs font-medium">Důvod změny<Input className="mt-1" maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}><X className="h-4 w-4 mr-1" /> Zrušit</Button>
              <Button onClick={submit} disabled={create.isPending || form.reason.trim().length < 3}>Uložit sazbu</Button>
            </div>
          </div>
        )}
        {(rates ?? []).length === 0 ? <p className="text-sm text-muted-foreground py-2">Zatím není nastavena žádná sazba.</p> : (
          <div className="divide-y">
            {[...(rates ?? [])].reverse().map((rate) => {
              const voided = rate.voidedAt !== null;
              return <div key={rate.id} className={`py-3 ${voided ? "opacity-55" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{rate.validFrom} až {rate.validTo ?? "dosud"}{voided && " · zrušeno"}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {canCost && <span>Náklad: <strong>{money(rate.costRate)}</strong></span>}
                      {canSale && <span>Prodej: <strong>{money(rate.saleRate)}</strong></span>}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{rate.reason}</div>
                    {rate.voidReason && <div className="mt-1 text-xs text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {rate.voidReason}</div>}
                  </div>
                  {canManage && !voided && voidingId !== rate.id && <Button size="sm" variant="ghost" onClick={() => { setVoidingId(rate.id); setVoidReason(""); }}>Zrušit platnost</Button>}
                </div>
                {voidingId === rate.id && <div className="mt-2 flex flex-wrap gap-2"><Input className="h-8 min-w-52 flex-1" placeholder="Důvod zrušení" maxLength={500} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /><Button size="sm" variant="destructive" disabled={voidReason.trim().length < 3 || voidRate.isPending} onClick={() => voidRate.mutate({ id: personId, rateId: rate.id, data: { reason: voidReason.trim() } }, { onSuccess: () => { void refresh(); setVoidingId(null); }, onError: () => toast({ title: "Sazbu se nepodařilo zrušit", variant: "destructive" }) })}>Potvrdit</Button><Button size="sm" variant="ghost" onClick={() => setVoidingId(null)}>Zpět</Button></div>}
              </div>;
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
