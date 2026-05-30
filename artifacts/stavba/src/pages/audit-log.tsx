import { useState } from "react";
import { format } from "date-fns";
import { useListAuditLogs, getListAuditLogsQueryKey, useListUsers, getListUsersQueryKey } from "@workspace/api-client-react";
import type { ListAuditLogsParams } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, X, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 50;

const ACTION_META: Record<string, { label: string; color: string }> = {
  create: { label: "Vytvoření", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  update: { label: "Úprava", color: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  delete: { label: "Smazání", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" },
  erase: { label: "GDPR výmaz", color: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300" },
};

const ENTITY_LABELS: Record<string, string> = {
  jobs: "Zakázky",
  tasks: "Úkoly",
  attachments: "Přílohy",
  materials: "Materiál",
  people: "Zaměstnanci",
  customers: "Zákazníci",
  "customer-contacts": "Kontakty",
  "customer-sites": "Stavby",
  activities: "Akce",
  users: "Uživatelé",
  machines: "Stroje",
  "warehouse-items": "Sklad",
  customer: "Zákazník (GDPR)",
  contact: "Kontakt (GDPR)",
  person: "Osoba (GDPR)",
};

export default function AuditLog() {
  const [userId, setUserId] = useState<string>("all");
  const [entityType, setEntityType] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);

  const { data: users } = useListUsers({ query: { queryKey: getListUsersQueryKey() } });

  const params: ListAuditLogsParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  if (userId !== "all") params.userId = Number(userId);
  if (entityType !== "all") params.entityType = entityType;
  if (fromDate) params.from = fromDate;
  if (toDate) params.to = `${toDate}T23:59:59`;

  const { data, isLoading } = useListAuditLogs(params, {
    query: { queryKey: getListAuditLogsQueryKey(params) },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetFilters = () => {
    setUserId("all");
    setEntityType("all");
    setFromDate("");
    setToDate("");
    setPage(0);
  };

  const hasFilters = userId !== "all" || entityType !== "all" || fromDate || toDate;

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <ScrollText className="w-7 h-7 text-rose-600" />
          <h1 className="text-2xl font-bold">Záznam změn</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Přehled všech úprav dat v aplikaci — kdo, kdy a co změnil.
        </p>

        {/* Filters */}
        <div className="bg-card border rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-end">
          <div className="w-[200px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Uživatel</label>
            <Select value={userId} onValueChange={(v) => { setUserId(v); setPage(0); }}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Všichni</SelectItem>
                {users?.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[200px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Oblast</label>
            <Select value={entityType} onValueChange={(v) => { setEntityType(v); setPage(0); }}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Vše</SelectItem>
                {Object.entries(ENTITY_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Od</label>
            <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(0); }} className="h-10" />
          </div>
          <div className="w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Do</label>
            <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(0); }} className="h-10" />
          </div>
          {hasFilters && (
            <Button variant="ghost" onClick={resetFilters} className="h-10">
              <X className="w-4 h-4 mr-1" /> Resetovat
            </Button>
          )}
        </div>

        {/* Table */}
        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 text-left whitespace-nowrap">Čas</th>
                  <th className="px-3 py-3 text-left">Uživatel</th>
                  <th className="px-3 py-3 text-left">Akce</th>
                  <th className="px-3 py-3 text-left">Oblast</th>
                  <th className="px-3 py-3 text-left">Detail</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [1, 2, 3, 4, 5].map((i) => (
                    <tr key={i} className="border-t"><td colSpan={5} className="px-3 py-2"><Skeleton className="h-8 w-full" /></td></tr>
                  ))
                ) : items.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">Žádné záznamy</td></tr>
                ) : items.map((e) => {
                  const action = ACTION_META[e.action] ?? { label: e.action, color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" };
                  const entityLabel = ENTITY_LABELS[e.entityType] ?? e.entityType;
                  return (
                    <tr key={e.id} className="border-t hover:bg-muted/30 align-top">
                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-xs">
                        {format(new Date(e.createdAt), "d.M.yyyy HH:mm:ss")}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">{e.actorName || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${action.color}`}>{action.label}</span>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {entityLabel}
                        {e.entityId != null && <span className="text-muted-foreground font-mono text-xs"> #{e.entityId}</span>}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground max-w-[420px] truncate" title={e.summary || ""}>
                        {e.summary || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-muted-foreground">Celkem: <strong>{total}</strong></p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-muted-foreground">Strana {page + 1} z {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
