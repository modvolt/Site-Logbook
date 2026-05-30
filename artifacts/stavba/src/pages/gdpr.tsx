import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomers, getListCustomersQueryKey,
  useListPeople, getListPeopleQueryKey,
  useListCustomerContacts, getListCustomerContactsQueryKey,
  exportSubjectData, useEraseSubjectData,
  getListAuditLogsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Download, Trash2, AlertTriangle, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type SubjectType = "customer" | "contact" | "person";

const SUBJECT_LABELS: Record<SubjectType, string> = {
  customer: "Zákazník",
  contact: "Kontakt zákazníka",
  person: "Zaměstnanec",
};

export default function Gdpr() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [subjectType, setSubjectType] = useState<SubjectType>("customer");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [contactId, setContactId] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey() } });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });
  const { data: contacts } = useListCustomerContacts(customerId ?? 0, {
    query: { queryKey: getListCustomerContactsQueryKey(customerId ?? 0), enabled: subjectType === "contact" && customerId != null },
  });

  const erase = useEraseSubjectData();

  const subjectId =
    subjectType === "customer" ? customerId :
    subjectType === "contact" ? contactId :
    personId;

  const subjectLabel = (): string => {
    if (subjectType === "customer") return customers?.find((c) => c.id === customerId)?.companyName ?? `#${customerId}`;
    if (subjectType === "contact") return contacts?.find((c) => c.id === contactId)?.name ?? `#${contactId}`;
    return people?.find((p) => p.id === personId)?.name ?? `#${personId}`;
  };

  const resetSelection = () => {
    setCustomerId(null);
    setContactId(null);
    setPersonId(null);
  };

  const handleExport = async () => {
    if (subjectId == null) {
      toast({ title: "Vyberte subjekt", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      const result = await exportSubjectData({ subjectType, subjectId });
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gdpr-export-${subjectType}-${subjectId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Export stažen" });
    } catch (err: any) {
      toast({ title: "Export selhal", description: err?.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const handleErase = () => {
    if (subjectId == null) {
      toast({ title: "Vyberte subjekt", variant: "destructive" });
      return;
    }
    const name = subjectLabel();
    if (!confirm(`Trvale vymazat osobní údaje subjektu „${name}"?\n\nTato akce je NEVRATNÁ. Související soubory v úložišti budou odstraněny. Doporučujeme nejprve provést export.`)) return;
    erase.mutate({ data: { subjectType, subjectId } }, {
      onSuccess: (res) => {
        toast({ title: "Údaje vymazány", description: res.message });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        if (customerId != null) queryClient.invalidateQueries({ queryKey: getListCustomerContactsQueryKey(customerId) });
        queryClient.invalidateQueries({ queryKey: getListAuditLogsQueryKey() });
        resetSelection();
      },
      onError: (err: any) => toast({ title: "Výmaz selhal", description: err?.message, variant: "destructive" }),
    });
  };

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[900px] mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="w-7 h-7 text-rose-600" />
          <h1 className="text-2xl font-bold">GDPR — osobní údaje</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Exportujte nebo trvale vymažte osobní údaje konkrétního subjektu (právo na přístup a právo být zapomenut).
        </p>

        {/* Selection */}
        <div className="bg-card border rounded-xl p-4 mb-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Typ subjektu</label>
            <Select value={subjectType} onValueChange={(v) => { setSubjectType(v as SubjectType); resetSelection(); }}>
              <SelectTrigger className="h-10 max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(SUBJECT_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {subjectType === "customer" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Zákazník</label>
              <Select value={customerId != null ? String(customerId) : ""} onValueChange={(v) => setCustomerId(Number(v))}>
                <SelectTrigger className="h-10 max-w-md"><SelectValue placeholder="Vyberte zákazníka…" /></SelectTrigger>
                <SelectContent>
                  {customers?.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.companyName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {subjectType === "contact" && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Zákazník</label>
                <Select value={customerId != null ? String(customerId) : ""} onValueChange={(v) => { setCustomerId(Number(v)); setContactId(null); }}>
                  <SelectTrigger className="h-10 max-w-md"><SelectValue placeholder="Vyberte zákazníka…" /></SelectTrigger>
                  <SelectContent>
                    {customers?.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.companyName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {customerId != null && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Kontakt</label>
                  <Select value={contactId != null ? String(contactId) : ""} onValueChange={(v) => setContactId(Number(v))}>
                    <SelectTrigger className="h-10 max-w-md"><SelectValue placeholder="Vyberte kontakt…" /></SelectTrigger>
                    <SelectContent>
                      {contacts && contacts.length > 0 ? (
                        contacts.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.role ? ` — ${c.role}` : ""}</SelectItem>)
                      ) : (
                        <div className="px-2 py-2 text-xs text-muted-foreground">Žádné kontakty</div>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          {subjectType === "person" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Zaměstnanec</label>
              <Select value={personId != null ? String(personId) : ""} onValueChange={(v) => setPersonId(Number(v))}>
                <SelectTrigger className="h-10 max-w-md"><SelectValue placeholder="Vyberte zaměstnance…" /></SelectTrigger>
                <SelectContent>
                  {people?.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button onClick={handleExport} disabled={subjectId == null || exporting} variant="outline">
              <Download className="w-4 h-4 mr-1.5" /> Exportovat údaje
            </Button>
            <Button onClick={handleErase} disabled={subjectId == null || erase.isPending} variant="destructive">
              <Trash2 className="w-4 h-4 mr-1.5" /> Trvale vymazat
            </Button>
          </div>
        </div>

        {/* Erase warning */}
        <div className="bg-rose-50 border border-rose-200 dark:bg-rose-950/30 dark:border-rose-900 rounded-xl px-4 py-3 mb-4 flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-rose-800 dark:text-rose-200">Výmaz je nevratný</p>
            <p className="text-rose-700 dark:text-rose-300 text-xs mt-0.5">
              U zákazníka se odstraní jeho kontaktní údaje, kontakty a stavby včetně nahraných souborů.
              Zakázky zůstanou zachovány jako anonymizovaná obchodní historie (vazba na zákazníka se zruší).
              Každý výmaz je zaznamenán v záznamu změn.
            </p>
          </div>
        </div>

        {/* Retention / privacy note */}
        <div className="bg-card border rounded-xl px-4 py-3 flex items-start gap-2 text-sm">
          <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
          <div className="text-muted-foreground text-xs space-y-1">
            <p className="font-medium text-foreground">Zásady uchovávání údajů</p>
            <p>
              Stavba uchovává osobní údaje zákazníků, jejich kontaktů a zaměstnanců pouze po dobu nezbytnou pro
              evidenci zakázek a plnění zákonných povinností. Subjekt údajů má právo na přístup ke svým údajům
              (export) a právo na výmaz. Žádosti vyřizujte prostřednictvím této stránky a uchovávejte exportovaný
              soubor jako doklad o vyřízení.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
