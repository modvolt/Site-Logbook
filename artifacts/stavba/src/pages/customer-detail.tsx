import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useParams, useLocation } from "wouter";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useListCustomers, useListJobs, useUpdateCustomer, useDeleteCustomer,
  useListCustomerContacts, useCreateCustomerContact, useUpdateCustomerContact, useDeleteCustomerContact,
  useListCustomerSites, useCreateCustomerSite, useUpdateCustomerSite, useDeleteCustomerSite,
  getListCustomersQueryKey, getListJobsQueryKey,
  getListCustomerContactsQueryKey, getListCustomerSitesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Building2, Phone, User, Edit3, Save, X, Plus,
  Briefcase, ChevronRight, Trash2, Hash, FileText, MapPin, Mail, Users, Store,
} from "lucide-react";
import { TypeBadge, StatusBadge } from "@/components/badges";
import { useToast } from "@/hooks/use-toast";

type ContactForm = { name: string; role: string; phone: string; email: string };
type SiteForm = { name: string; address: string; contactPerson: string; phone: string; note: string };

const emptyContact: ContactForm = { name: "", role: "", phone: "", email: "" };
const emptySite: SiteForm = { name: "", address: "", contactPerson: "", phone: "", note: "" };

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps } = useConfirmDialog();

  const { data: customers, isLoading: loadingCustomer } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const customer = customers?.find((c) => c.id === id);

  const { data: allJobs, isLoading: loadingJobs } = useListJobs(
    {},
    { query: { queryKey: getListJobsQueryKey({}) } }
  );
  const jobs = allJobs?.filter((j) => j.customerId === id) ?? [];

  const { data: contacts, isLoading: loadingContacts } = useListCustomerContacts(id, {
    query: { queryKey: getListCustomerContactsQueryKey(id), enabled: id > 0 },
  });
  const { data: sites, isLoading: loadingSites } = useListCustomerSites(id, {
    query: { queryKey: getListCustomerSitesQueryKey(id), enabled: id > 0 },
  });

  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();
  const createContact = useCreateCustomerContact();
  const updateContact = useUpdateCustomerContact();
  const deleteContact = useDeleteCustomerContact();
  const createSite = useCreateCustomerSite();
  const updateSite = useUpdateCustomerSite();
  const deleteSite = useDeleteCustomerSite();

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    companyName: "", contactPerson: "", phone: "", email: "", ic: "", dic: "", address: "",
  });

  // Contacts UI state
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState<ContactForm>(emptyContact);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [editContact, setEditContact] = useState<ContactForm>(emptyContact);

  // Sites UI state
  const [showAddSite, setShowAddSite] = useState(false);
  const [newSite, setNewSite] = useState<SiteForm>(emptySite);
  const [editingSiteId, setEditingSiteId] = useState<number | null>(null);
  const [editSite, setEditSite] = useState<SiteForm>(emptySite);

  const invalidateContacts = () => invalidateData(queryClient, "customers");
  const invalidateSites = () => invalidateData(queryClient, "customers");

  const startEdit = () => {
    if (!customer) return;
    setEditForm({
      companyName: customer.companyName,
      contactPerson: customer.contactPerson || "",
      phone: customer.phone || "",
      email: customer.email || "",
      ic: customer.ic || "",
      dic: customer.dic || "",
      address: customer.address || "",
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
          email: editForm.email.trim() || null,
          ic: editForm.ic.trim() || null,
          dic: editForm.dic.trim() || null,
          address: editForm.address.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateData(queryClient, "customers");
          setEditing(false);
          toast({ title: "Zákazník uložen" });
        },
        onError: () => toast({ title: "Nepodařilo se uložit", variant: "destructive" }),
      }
    );
  };

  const handleDelete = () => {
    openConfirm("Opravdu smazat zákazníka?", () => {
      deleteCustomer.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateData(queryClient, "customers");
          toast({ title: "Zákazník smazán" });
          setLocation("/customers");
        },
        onError: () => toast({ title: "Nepodařilo se smazat", variant: "destructive" }),
      }
    );
    });
  };

  // --- Contacts handlers ---
  const handleAddContact = () => {
    if (!newContact.name.trim()) return;
    createContact.mutate(
      {
        customerId: id,
        data: {
          name: newContact.name.trim(),
          role: newContact.role.trim() || null,
          phone: newContact.phone.trim() || null,
          email: newContact.email.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateContacts();
          setNewContact(emptyContact);
          setShowAddContact(false);
          toast({ title: "Kontakt přidán" });
        },
        onError: () => toast({ title: "Nepodařilo se přidat kontakt", variant: "destructive" }),
      }
    );
  };

  const startEditContact = (c: NonNullable<typeof contacts>[number]) => {
    setEditingContactId(c.id);
    setEditContact({
      name: c.name,
      role: c.role || "",
      phone: c.phone || "",
      email: c.email || "",
    });
  };

  const handleUpdateContact = (contactId: number) => {
    if (!editContact.name.trim()) return;
    updateContact.mutate(
      {
        id: contactId,
        data: {
          name: editContact.name.trim(),
          role: editContact.role.trim() || null,
          phone: editContact.phone.trim() || null,
          email: editContact.email.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateContacts();
          setEditingContactId(null);
          toast({ title: "Kontakt upraven" });
        },
        onError: () => toast({ title: "Nepodařilo se upravit kontakt", variant: "destructive" }),
      }
    );
  };

  const handleDeleteContact = (contactId: number) => {
    openConfirm("Opravdu smazat kontakt?", () => {
      deleteContact.mutate(
      { id: contactId },
      {
        onSuccess: () => {
          invalidateContacts();
          toast({ title: "Kontakt smazán" });
        },
        onError: () => toast({ title: "Nepodařilo se smazat kontakt", variant: "destructive" }),
      }
    );
    });
  };

  // --- Sites handlers ---
  const handleAddSite = () => {
    if (!newSite.name.trim()) return;
    createSite.mutate(
      {
        customerId: id,
        data: {
          name: newSite.name.trim(),
          address: newSite.address.trim() || null,
          contactPerson: newSite.contactPerson.trim() || null,
          phone: newSite.phone.trim() || null,
          note: newSite.note.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateSites();
          setNewSite(emptySite);
          setShowAddSite(false);
          toast({ title: "Stavba přidána" });
        },
        onError: () => toast({ title: "Nepodařilo se přidat stavbu", variant: "destructive" }),
      }
    );
  };

  const startEditSite = (s: NonNullable<typeof sites>[number]) => {
    setEditingSiteId(s.id);
    setEditSite({
      name: s.name,
      address: s.address || "",
      contactPerson: s.contactPerson || "",
      phone: s.phone || "",
      note: s.note || "",
    });
  };

  const handleUpdateSite = (siteId: number) => {
    if (!editSite.name.trim()) return;
    updateSite.mutate(
      {
        id: siteId,
        data: {
          name: editSite.name.trim(),
          address: editSite.address.trim() || null,
          contactPerson: editSite.contactPerson.trim() || null,
          phone: editSite.phone.trim() || null,
          note: editSite.note.trim() || null,
        },
      },
      {
        onSuccess: () => {
          invalidateSites();
          setEditingSiteId(null);
          toast({ title: "Stavba upravena" });
        },
        onError: () => toast({ title: "Nepodařilo se upravit stavbu", variant: "destructive" }),
      }
    );
  };

  const handleDeleteSite = (siteId: number) => {
    openConfirm("Opravdu smazat stavbu?", () => {
      deleteSite.mutate(
      { id: siteId },
      {
        onSuccess: () => {
          invalidateSites();
          toast({ title: "Stavba smazána" });
        },
        onError: () => toast({ title: "Nepodařilo se smazat stavbu", variant: "destructive" }),
      }
    );
    });
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
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">E-mail</label>
                  <Input
                    value={editForm.email}
                    onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="email@firma.cz"
                    type="email"
                    className="h-11"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground mb-1 block">IČ</label>
                    <Input
                      value={editForm.ic}
                      onChange={(e) => setEditForm((p) => ({ ...p, ic: e.target.value }))}
                      placeholder="IČ"
                      className="h-11"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground mb-1 block">DIČ</label>
                    <Input
                      value={editForm.dic}
                      onChange={(e) => setEditForm((p) => ({ ...p, dic: e.target.value }))}
                      placeholder="CZ..."
                      className="h-11"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">Adresa</label>
                  <Input
                    value={editForm.address}
                    onChange={(e) => setEditForm((p) => ({ ...p, address: e.target.value }))}
                    placeholder="Ulice, město, PSČ"
                    className="h-11"
                  />
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
                  {customer.email && (
                    <a
                      href={`mailto:${customer.email}`}
                      className="flex items-center gap-2 text-primary font-medium hover:underline"
                    >
                      <Mail className="h-4 w-4 shrink-0" />
                      <span className="text-sm">{customer.email}</span>
                    </a>
                  )}
                  {customer.ic && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Hash className="h-4 w-4 shrink-0" />
                      <span className="text-sm">IČ: {customer.ic}</span>
                    </div>
                  )}
                  {customer.dic && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <FileText className="h-4 w-4 shrink-0" />
                      <span className="text-sm">DIČ: {customer.dic}</span>
                    </div>
                  )}
                  {customer.address && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-4 w-4 shrink-0" />
                      <span className="text-sm">{customer.address}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contacts */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Users className="h-4 w-4 text-sky-500" /> Kontaktní osoby
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => { setShowAddContact(true); setNewContact(emptyContact); }}
          >
            <Plus className="h-4 w-4 mr-1" /> Přidat
          </Button>
        </div>

        {showAddContact && (
          <Card className="mb-3 border-primary/30 bg-primary/5">
            <CardContent className="p-4 space-y-3">
              <Input
                value={newContact.name}
                onChange={(e) => setNewContact((p) => ({ ...p, name: e.target.value }))}
                placeholder="Jméno *"
                className="h-11"
                autoFocus
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  value={newContact.role}
                  onChange={(e) => setNewContact((p) => ({ ...p, role: e.target.value }))}
                  placeholder="Funkce (např. vedoucí)"
                  className="h-11"
                />
                <Input
                  value={newContact.phone}
                  onChange={(e) => setNewContact((p) => ({ ...p, phone: e.target.value }))}
                  placeholder="Telefon"
                  type="tel"
                  className="h-11"
                />
              </div>
              <Input
                value={newContact.email}
                onChange={(e) => setNewContact((p) => ({ ...p, email: e.target.value }))}
                placeholder="E-mail"
                type="email"
                className="h-11"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddContact} disabled={!newContact.name.trim() || createContact.isPending} className="h-9">
                  <Save className="h-4 w-4 mr-1" /> Uložit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowAddContact(false); setNewContact(emptyContact); }} className="h-9">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-2 mb-6">
          {loadingContacts ? (
            <Skeleton className="h-16 w-full" />
          ) : contacts && contacts.length > 0 ? (
            contacts.map((c) => (
              <Card key={c.id}>
                <CardContent className="p-4">
                  {editingContactId === c.id ? (
                    <div className="space-y-3">
                      <Input
                        value={editContact.name}
                        onChange={(e) => setEditContact((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Jméno *"
                        className="h-11"
                        autoFocus
                      />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          value={editContact.role}
                          onChange={(e) => setEditContact((p) => ({ ...p, role: e.target.value }))}
                          placeholder="Funkce"
                          className="h-11"
                        />
                        <Input
                          value={editContact.phone}
                          onChange={(e) => setEditContact((p) => ({ ...p, phone: e.target.value }))}
                          placeholder="Telefon"
                          type="tel"
                          className="h-11"
                        />
                      </div>
                      <Input
                        value={editContact.email}
                        onChange={(e) => setEditContact((p) => ({ ...p, email: e.target.value }))}
                        placeholder="E-mail"
                        type="email"
                        className="h-11"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleUpdateContact(c.id)} disabled={!editContact.name.trim() || updateContact.isPending} className="h-9">
                          <Save className="h-4 w-4 mr-1" /> Uložit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingContactId(null)} className="h-9">
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="bg-sky-100 dark:bg-sky-950/40 p-2 rounded-lg text-sky-600 shrink-0">
                        <User className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">
                          {c.name}
                          {c.role && <span className="font-normal text-muted-foreground"> · {c.role}</span>}
                        </p>
                        <div className="flex flex-col gap-1 mt-1">
                          {c.phone && (
                            <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                              <Phone className="h-3.5 w-3.5" /> {c.phone}
                            </a>
                          )}
                          {c.email && (
                            <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-sm text-primary hover:underline break-all">
                              <Mail className="h-3.5 w-3.5 shrink-0" /> {c.email}
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => startEditContact(c)}>
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteContact(c.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-center py-6 text-muted-foreground border-2 border-dashed rounded-xl border-muted text-sm">
              Žádné kontaktní osoby.
            </div>
          )}
        </div>

        {/* Sites (stavby) */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Store className="h-4 w-4 text-amber-500" /> Stavby / pobočky
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => { setShowAddSite(true); setNewSite(emptySite); }}
          >
            <Plus className="h-4 w-4 mr-1" /> Přidat
          </Button>
        </div>

        {showAddSite && (
          <Card className="mb-3 border-primary/30 bg-primary/5">
            <CardContent className="p-4 space-y-3">
              <Input
                value={newSite.name}
                onChange={(e) => setNewSite((p) => ({ ...p, name: e.target.value }))}
                placeholder="Název stavby / pobočky *"
                className="h-11"
                autoFocus
              />
              <Input
                value={newSite.address}
                onChange={(e) => setNewSite((p) => ({ ...p, address: e.target.value }))}
                placeholder="Adresa"
                className="h-11"
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  value={newSite.contactPerson}
                  onChange={(e) => setNewSite((p) => ({ ...p, contactPerson: e.target.value }))}
                  placeholder="Kontaktní osoba"
                  className="h-11"
                />
                <Input
                  value={newSite.phone}
                  onChange={(e) => setNewSite((p) => ({ ...p, phone: e.target.value }))}
                  placeholder="Telefon"
                  type="tel"
                  className="h-11"
                />
              </div>
              <Input
                value={newSite.note}
                onChange={(e) => setNewSite((p) => ({ ...p, note: e.target.value }))}
                placeholder="Poznámka"
                className="h-11"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddSite} disabled={!newSite.name.trim() || createSite.isPending} className="h-9">
                  <Save className="h-4 w-4 mr-1" /> Uložit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowAddSite(false); setNewSite(emptySite); }} className="h-9">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-2 mb-6">
          {loadingSites ? (
            <Skeleton className="h-16 w-full" />
          ) : sites && sites.length > 0 ? (
            sites.map((s) => (
              <Card key={s.id}>
                <CardContent className="p-4">
                  {editingSiteId === s.id ? (
                    <div className="space-y-3">
                      <Input
                        value={editSite.name}
                        onChange={(e) => setEditSite((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Název stavby *"
                        className="h-11"
                        autoFocus
                      />
                      <Input
                        value={editSite.address}
                        onChange={(e) => setEditSite((p) => ({ ...p, address: e.target.value }))}
                        placeholder="Adresa"
                        className="h-11"
                      />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          value={editSite.contactPerson}
                          onChange={(e) => setEditSite((p) => ({ ...p, contactPerson: e.target.value }))}
                          placeholder="Kontaktní osoba"
                          className="h-11"
                        />
                        <Input
                          value={editSite.phone}
                          onChange={(e) => setEditSite((p) => ({ ...p, phone: e.target.value }))}
                          placeholder="Telefon"
                          type="tel"
                          className="h-11"
                        />
                      </div>
                      <Input
                        value={editSite.note}
                        onChange={(e) => setEditSite((p) => ({ ...p, note: e.target.value }))}
                        placeholder="Poznámka"
                        className="h-11"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleUpdateSite(s.id)} disabled={!editSite.name.trim() || updateSite.isPending} className="h-9">
                          <Save className="h-4 w-4 mr-1" /> Uložit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingSiteId(null)} className="h-9">
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="flex items-start gap-3 cursor-pointer"
                      onClick={() => setLocation(`/customer-sites/${s.id}`)}
                    >
                      <div className="bg-amber-100 dark:bg-amber-950/40 p-2 rounded-lg text-amber-600 shrink-0">
                        <Store className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{s.name}</p>
                        <div className="flex flex-col gap-1 mt-1">
                          {s.address && (
                            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                              <MapPin className="h-3.5 w-3.5 shrink-0" /> {s.address}
                            </div>
                          )}
                          {s.contactPerson && (
                            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                              <User className="h-3.5 w-3.5 shrink-0" /> {s.contactPerson}
                            </div>
                          )}
                          {s.phone && (
                            <a href={`tel:${s.phone}`} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                              <Phone className="h-3.5 w-3.5" /> {s.phone}
                            </a>
                          )}
                          {s.note && <p className="text-sm text-muted-foreground">{s.note}</p>}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={(e) => { e.stopPropagation(); startEditSite(s); }}>
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={(e) => { e.stopPropagation(); handleDeleteSite(s.id); }}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 self-center" />
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-center py-6 text-muted-foreground border-2 border-dashed rounded-xl border-muted text-sm">
              Žádné stavby ani pobočky.
            </div>
          )}
        </div>

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
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
