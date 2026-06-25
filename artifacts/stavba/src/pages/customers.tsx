import { useState, useEffect } from "react";
import { useSearch, useLocation } from "wouter";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { 
  useListCustomers, useCreateCustomer, useUpdateCustomer, useDeleteCustomer, 
  getListCustomersQueryKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Trash2, Plus, Edit3, Save, X, Phone, ChevronRight, Upload, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import CustomerCsvImport from "@/components/customer-csv-import";

type CustomerForm = {
  companyName: string;
  contactPerson: string;
  phone: string;
  email: string;
  ic: string;
  dic: string;
  address: string;
};

const emptyForm: CustomerForm = {
  companyName: "",
  contactPerson: "",
  phone: "",
  email: "",
  ic: "",
  dic: "",
  address: "",
};

function readSearchFromUrl(search: string): string {
  return new URLSearchParams(search).get("q") ?? "";
}

function buildCustomersSearch(q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default function Customers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search_ = useSearch();
  const { openConfirm, dialogProps } = useConfirmDialog();

  const { data: customers, isLoading } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() }
  });

  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();

  const [search, setSearch] = useState(() => readSearchFromUrl(search_));

  useEffect(() => {
    setSearch(readSearchFromUrl(search_));
  }, [search_]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setLocation(buildCustomersSearch(value), { replace: true });
  };
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newForm, setNewForm] = useState<CustomerForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<CustomerForm>(emptyForm);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newForm.companyName.trim()) return;
    createCustomer.mutate({
      data: {
        companyName: newForm.companyName.trim(),
        contactPerson: newForm.contactPerson.trim() || null,
        phone: newForm.phone.trim() || null,
        email: newForm.email.trim() || null,
        ic: newForm.ic.trim() || null,
        dic: newForm.dic.trim() || null,
        address: newForm.address.trim() || null,
      }
    }, {
      onSuccess: () => {
        setNewForm(emptyForm);
        setShowAddForm(false);
        invalidateData(queryClient, "customers");
        toast({ title: "Zákazník přidán" });
      },
      onError: () => toast({ title: "Nepodařilo se přidat zákazníka", variant: "destructive" })
    });
  };

  const startEdit = (c: NonNullable<typeof customers>[number]) => {
    setEditingId(c.id);
    setEditForm({
      companyName: c.companyName,
      contactPerson: c.contactPerson || "",
      phone: c.phone || "",
      email: c.email || "",
      ic: c.ic || "",
      dic: c.dic || "",
      address: c.address || "",
    });
  };

  const handleUpdate = (id: number) => {
    updateCustomer.mutate({
      id,
      data: {
        companyName: editForm.companyName.trim(),
        contactPerson: editForm.contactPerson.trim() || null,
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        ic: editForm.ic.trim() || null,
        dic: editForm.dic.trim() || null,
        address: editForm.address.trim() || null,
      }
    }, {
      onSuccess: () => {
        setEditingId(null);
        invalidateData(queryClient, "customers");
        toast({ title: "Zákazník upraven" });
      },
      onError: () => toast({ title: "Nepodařilo se upravit zákazníka", variant: "destructive" })
    });
  };

  const handleDelete = (id: number) => {
    openConfirm("Opravdu smazat tohoto zákazníka?", () => {
      deleteCustomer.mutate({ id }, {
        onSuccess: () => {
          invalidateData(queryClient, "customers");
          toast({ title: "Zákazník smazán" });
        },
        onError: () => toast({ title: "Nepodařilo se smazat zákazníka", variant: "destructive" })
      });
    });
  };

  const query = search.trim().toLowerCase();
  const filtered = customers?.filter(c =>
    c.companyName.toLowerCase().includes(query) ||
    (c.contactPerson || "").toLowerCase().includes(query) ||
    (c.phone || "").toLowerCase().includes(query) ||
    (c.email || "").toLowerCase().includes(query) ||
    (c.ic || "").toLowerCase().includes(query)
  );

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Zákazníci</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowImport(true)} className="h-10">
            <Upload className="h-4 w-4 mr-2" /> Import CSV
          </Button>
          <Button onClick={() => { setShowAddForm(true); setEditingId(null); }} className="h-10">
            <Plus className="h-4 w-4 mr-2" /> Přidat zákazníka
          </Button>
        </div>
      </div>

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="Hledat zákazníky..."
          className="pl-10 h-12 text-base"
        />
      </div>

      <CustomerCsvImport
        open={showImport}
        onOpenChange={setShowImport}
        onImported={() => invalidateData(queryClient, "customers")}
      />

      {showAddForm && (
        <Card className="mb-6 border-primary/30 bg-primary/5">
          <CardContent className="p-4">
            <h2 className="font-bold text-base mb-4">Nový zákazník</h2>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Název firmy *</label>
                <Input
                  value={newForm.companyName}
                  onChange={e => setNewForm(p => ({ ...p, companyName: e.target.value }))}
                  placeholder="např. Stavby s.r.o."
                  className="h-12 text-base"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">Kontaktní osoba</label>
                  <Input
                    value={newForm.contactPerson}
                    onChange={e => setNewForm(p => ({ ...p, contactPerson: e.target.value }))}
                    placeholder="Jméno kontaktu"
                    className="h-12 text-base"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">Telefon</label>
                  <Input
                    value={newForm.phone}
                    onChange={e => setNewForm(p => ({ ...p, phone: e.target.value }))}
                    placeholder="+420 ..."
                    type="tel"
                    className="h-12 text-base"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">E-mail</label>
                <Input
                  value={newForm.email}
                  onChange={e => setNewForm(p => ({ ...p, email: e.target.value }))}
                  placeholder="email@firma.cz"
                  type="email"
                  className="h-12 text-base"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">IČ</label>
                  <Input
                    value={newForm.ic}
                    onChange={e => setNewForm(p => ({ ...p, ic: e.target.value }))}
                    placeholder="IČ"
                    className="h-12 text-base"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">DIČ</label>
                  <Input
                    value={newForm.dic}
                    onChange={e => setNewForm(p => ({ ...p, dic: e.target.value }))}
                    placeholder="CZ..."
                    className="h-12 text-base"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Adresa</label>
                <Input
                  value={newForm.address}
                  onChange={e => setNewForm(p => ({ ...p, address: e.target.value }))}
                  placeholder="Ulice, město, PSČ"
                  className="h-12 text-base"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="submit" disabled={!newForm.companyName.trim() || createCustomer.isPending} className="h-11 px-6">
                  <Save className="h-4 w-4 mr-2" /> Uložit
                </Button>
                <Button type="button" variant="ghost" onClick={() => { setShowAddForm(false); setNewForm(emptyForm); }} className="h-11">
                  <X className="h-4 w-4 mr-2" /> Zrušit
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)
        ) : filtered && filtered.length > 0 ? (
          filtered.map(customer => (
            <Card key={customer.id} className="hover:bg-muted/30 transition-colors">
              <CardContent className="p-4">
                {editingId === customer.id ? (
                  <div className="space-y-3">
                    <Input
                      value={editForm.companyName}
                      onChange={e => setEditForm(p => ({ ...p, companyName: e.target.value }))}
                      className="h-11 text-base font-medium"
                      autoFocus
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Input
                        value={editForm.contactPerson}
                        onChange={e => setEditForm(p => ({ ...p, contactPerson: e.target.value }))}
                        placeholder="Kontaktní osoba"
                        className="h-11"
                      />
                      <Input
                        value={editForm.phone}
                        onChange={e => setEditForm(p => ({ ...p, phone: e.target.value }))}
                        placeholder="Telefon"
                        type="tel"
                        className="h-11"
                      />
                    </div>
                    <Input
                      value={editForm.email}
                      onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                      placeholder="E-mail"
                      type="email"
                      className="h-11"
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Input
                        value={editForm.ic}
                        onChange={e => setEditForm(p => ({ ...p, ic: e.target.value }))}
                        placeholder="IČ"
                        className="h-11"
                      />
                      <Input
                        value={editForm.dic}
                        onChange={e => setEditForm(p => ({ ...p, dic: e.target.value }))}
                        placeholder="DIČ"
                        className="h-11"
                      />
                    </div>
                    <Input
                      value={editForm.address}
                      onChange={e => setEditForm(p => ({ ...p, address: e.target.value }))}
                      placeholder="Adresa"
                      className="h-11"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleUpdate(customer.id)} disabled={!editForm.companyName.trim() || updateCustomer.isPending} className="h-9">
                        <Save className="h-4 w-4 mr-1" /> Uložit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="h-9">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-3 cursor-pointer"
                    onClick={() => setLocation(`/customers/${customer.id}`)}
                  >
                    <div className="bg-primary/10 p-2.5 rounded-full text-primary shrink-0">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-base truncate">{customer.companyName}</p>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        {customer.contactPerson && (
                          <span className="text-sm text-muted-foreground">{customer.contactPerson}</span>
                        )}
                        {customer.phone && (
                          <a
                            href={`tel:${customer.phone}`}
                            className="flex items-center gap-1 text-sm text-primary font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Phone className="h-3.5 w-3.5" />
                            {customer.phone}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" onClick={(e) => { e.stopPropagation(); startEdit(customer); }}>
                        <Edit3 className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:bg-destructive/10" onClick={(e) => { e.stopPropagation(); handleDelete(customer.id); }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-5 w-5 text-muted-foreground ml-1" />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        ) : query ? (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Building2 className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Žádní zákazníci odpovídající vašemu hledání.</p>
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Building2 className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>Zatím žádní zákazníci.</p>
            <p className="text-sm mt-1">Klikněte na „Přidat zákazníka" a začněte.</p>
          </div>
        )}
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
