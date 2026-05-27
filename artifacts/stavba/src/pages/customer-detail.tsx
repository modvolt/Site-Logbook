import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useListCustomers, useListJobs, useUpdateCustomer, useDeleteCustomer,
  getListCustomersQueryKey, getListJobsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Building2, Phone, User, Edit3, Save, X, Plus,
  Briefcase, ChevronRight, Trash2,
} from "lucide-react";
import { TypeBadge, StatusBadge } from "@/components/badges";
import { useToast } from "@/hooks/use-toast";

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: customers, isLoading: loadingCustomer } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const customer = customers?.find((c) => c.id === id);

  const { data: allJobs, isLoading: loadingJobs } = useListJobs(
    {},
    { query: { queryKey: getListJobsQueryKey({}) } }
  );
  const jobs = allJobs?.filter((j) => j.customerId === id) ?? [];

  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ companyName: "", contactPerson: "", phone: "" });

  const startEdit = () => {
    if (!customer) return;
    setEditForm({
      companyName: customer.companyName,
      contactPerson: customer.contactPerson || "",
      phone: customer.phone || "",
    });
    setEditing(true);
  };

  const handleSave = () => {
    if (!editForm.companyName.trim()) return;
    updateCustomer.mutate(
      {
        id,
        data: {
          companyName: editForm.companyName.trim(),
          contactPerson: editForm.contactPerson.trim() || null,
          phone: editForm.phone.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
          setEditing(false);
          toast({ title: "Zákazník uložen" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      }
    );
  };

  const handleDelete = () => {
    if (!confirm("Opravdu smazat zákazníka?")) return;
    deleteCustomer.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
          toast({ title: "Zákazník smazán" });
          setLocation("/customers");
        },
        onError: () => toast({ title: "Nepodařilo se smazat", variant: "destructive" }),
      }
    );
  };

  if (loadingCustomer) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground">
        <Building2 className="h-12 w-12 mb-4 opacity-20" />
        <p>Zákazník nenalezen.</p>
        <Button variant="ghost" className="mt-4" onClick={() => setLocation("/customers")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Zpět na zákazníky
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-background pb-20 md:pb-0">
      <div className="sticky top-0 z-10 bg-card border-b p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/customers")}>
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{customer.companyName}</h1>
          <p className="text-sm text-muted-foreground">{jobs.length} zakázek</p>
        </div>
        {!editing && (
          <div className="flex gap-1 shrink-0">
            <Button variant="ghost" size="icon" onClick={startEdit}>
              <Edit3 className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={handleDelete}>
              <Trash2 className="h-5 w-5" />
            </Button>
          </div>
        )}
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full">
        {/* Customer info card */}
        <Card className="mb-6">
          <CardContent className="p-4">
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">Název firmy *</label>
                  <Input
                    value={editForm.companyName}
                    onChange={(e) => setEditForm((p) => ({ ...p, companyName: e.target.value }))}
                    className="h-11 text-base"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground mb-1 block">Kontaktní osoba</label>
                    <Input
                      value={editForm.contactPerson}
                      onChange={(e) => setEditForm((p) => ({ ...p, contactPerson: e.target.value }))}
                      placeholder="Jméno"
                      className="h-11"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground mb-1 block">Telefon</label>
                    <Input
                      value={editForm.phone}
                      onChange={(e) => setEditForm((p) => ({ ...p, phone: e.target.value }))}
                      placeholder="+420 ..."
                      type="tel"
                      className="h-11"
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={handleSave}
                    disabled={!editForm.companyName.trim() || updateCustomer.isPending}
                    className="h-10"
                  >
                    <Save className="h-4 w-4 mr-2" /> Uložit
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)} className="h-10">
                    <X className="h-4 w-4 mr-2" /> Zrušit
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-4">
                <div className="bg-emerald-100 dark:bg-emerald-950/40 p-3 rounded-xl text-emerald-600 shrink-0">
                  <Building2 className="h-6 w-6" />
                </div>
                <div className="flex-1 space-y-2">
                  <h2 className="text-lg font-bold">{customer.companyName}</h2>
                  {customer.contactPerson && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <User className="h-4 w-4 shrink-0" />
                      <span className="text-sm">{customer.contactPerson}</span>
                    </div>
                  )}
                  {customer.phone && (
                    <a
                      href={`tel:${customer.phone}`}
                      className="flex items-center gap-2 text-primary font-medium hover:underline"
                    >
                      <Phone className="h-4 w-4 shrink-0" />
                      <span className="text-sm">{customer.phone}</span>
                    </a>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* New job for this customer */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-violet-500" /> Zakázky
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() =>
              setLocation(`/jobs/new?customerId=${id}&clientSite=${encodeURIComponent(customer.companyName)}`)
            }
          >
            <Plus className="h-4 w-4 mr-1" /> Nová zakázka
          </Button>
        </div>

        {loadingJobs ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Briefcase className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm">Žádné zakázky pro tohoto zákazníka.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <Card
                key={job.id}
                className="hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => setLocation(`/jobs/${job.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{job.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(job.date), "d. MMMM yyyy", { locale: cs })}
                      </p>
                      <div className="flex gap-2 mt-1.5">
                        <TypeBadge type={job.type} />
                        <StatusBadge status={job.status} />
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
