import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { format } from "date-fns";
import { 
  useCreateJob, useListPeople, useCreateTask, useCreateMaterial,
  useListCustomers, useListJobs, useListWarehouseItems, useListCustomerSites,
  getListPeopleQueryKey, getListJobsQueryKey, getListCustomersQueryKey, getListWarehouseItemsQueryKey, getListCustomerSitesQueryKey 
} from "@workspace/api-client-react";
import type { JobInputStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateData } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Autocomplete } from "@/components/autocomplete";
import { Label } from "@/components/ui/label";
import { TimePicker } from "@/components/time-picker";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_TYPES, JOB_STATUSES } from "@/components/badges";
import { ArrowLeft, Save, Plus, X, CheckSquare, Building2, Phone, Navigation, ShoppingCart, RefreshCw, LocateFixed, MapPin, Loader2 } from "lucide-react";
import { DecimalInput, parseDecimal, decimalError } from "@/components/decimal-input";
import { useToast } from "@/hooks/use-toast";

export default function JobForm() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const queryParams = new URLSearchParams(search);
  const initialDate = queryParams.get("date") || format(new Date(), "yyyy-MM-dd");
  const initialClientSite = queryParams.get("clientSite") || "";
  const initialCustomerId = queryParams.get("customerId") ? parseInt(queryParams.get("customerId")!) : null;
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createJob = useCreateJob();

  const [isDirty, setIsDirty] = useState(false);
  const markDirty = useCallback(() => setIsDirty(true), []);
  const { confirmNavigation } = useUnsavedChanges(isDirty);
  const createTask = useCreateTask();
  const createMaterial = useCreateMaterial();
  
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });
  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey() } });
  const { data: existingJobs } = useListJobs(undefined, { query: { queryKey: getListJobsQueryKey() } });
  const { data: warehouseItems } = useListWarehouseItems(undefined, { query: { queryKey: getListWarehouseItemsQueryKey() } });

  const titleSuggestions = (existingJobs ?? []).map(j => j.title);
  const materialSuggestions = (warehouseItems ?? []).map(w => w.name);

  const [formData, setFormData] = useState({
    title: "",
    type: "planned_work",
    clientSite: initialClientSite,
    address: "",
    date: initialDate,
    startTime: "",
    endTime: "",
    assignedPersonId: "none",
    status: "planned",
    notes: "",
    customerId: initialCustomerId,
    recurrenceIntervalDays: "",
  });

  const { data: customerSites } = useListCustomerSites(formData.customerId ?? 0, {
    query: { queryKey: getListCustomerSitesQueryKey(formData.customerId ?? 0), enabled: !!formData.customerId },
  });

  const [titleError, setTitleError] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<string[]>([]);
  const [newTaskInput, setNewTaskInput] = useState("");
  type MaterialRow = { name: string; quantity: string; unit: string; pricePerUnit: string };
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [newMaterial, setNewMaterial] = useState<MaterialRow>({ name: "", quantity: "", unit: "ks", pricePerUnit: "" });
  const customerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerRef.current && !customerRef.current.contains(e.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setSelectedSiteId(null);
  }, [formData.customerId]);

  const filteredCustomers = customers?.filter(c =>
    c.companyName.toLowerCase().includes(customerSearch.toLowerCase()) ||
    (c.contactPerson || "").toLowerCase().includes(customerSearch.toLowerCase())
  ) || [];

  const selectedCustomer = customers?.find(c => c.id === formData.customerId);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    markDirty();
  };

  const handleSelectChange = (name: string, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value }));
    markDirty();
  };

  const handleUseCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      toast({
        title: "GPS není dostupné",
        description: "Tento prohlížeč nepodporuje zjištění polohy.",
        variant: "destructive",
      });
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const coords = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&accept-language=cs`,
            { headers: { Accept: "application/json" } },
          );
          const data = res.ok ? await res.json() : null;
          const address: string | undefined = data?.display_name;
          if (address) {
            setFormData((p) => ({ ...p, address }));
            markDirty();
            toast({ title: "Poloha načtena" });
          } else {
            setFormData((p) => ({ ...p, address: coords }));
            markDirty();
            toast({ title: "Poloha načtena (souřadnice)" });
          }
        } catch {
          setFormData((p) => ({ ...p, address: coords }));
          markDirty();
          toast({ title: "Poloha načtena (souřadnice)" });
        } finally {
          setGpsLoading(false);
        }
      },
      (err) => {
        setGpsLoading(false);
        toast({
          title: "Nepodařilo se zjistit polohu",
          description:
            err.code === err.PERMISSION_DENIED
              ? "Povolte přístup k poloze v prohlížeči."
              : "Zkuste to prosím znovu.",
          variant: "destructive",
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const selectCustomer = (c: NonNullable<typeof customers>[number]) => {
    setFormData(prev => ({ ...prev, customerId: c.id, clientSite: c.companyName }));
    setCustomerSearch(c.companyName);
    setShowCustomerDropdown(false);
    markDirty();
  };

  const clearCustomer = () => {
    setFormData(prev => ({ ...prev, customerId: null, clientSite: "" }));
    setCustomerSearch("");
    setSelectedSiteId(null);
    markDirty();
  };

  const addTask = () => {
    if (!newTaskInput.trim()) return;
    setTasks(prev => [...prev, newTaskInput.trim()]);
    setNewTaskInput("");
    markDirty();
  };

  const removeTask = (i: number) => { setTasks(prev => prev.filter((_, idx) => idx !== i)); markDirty(); };

  const addMaterial = () => {
    if (!newMaterial.name.trim()) return;
    setMaterials(prev => [...prev, { ...newMaterial }]);
    setNewMaterial({ name: "", quantity: "", unit: "ks", pricePerUnit: "" });
    markDirty();
  };

  const removeMaterial = (i: number) => { setMaterials(prev => prev.filter((_, idx) => idx !== i)); markDirty(); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      setTitleError("Název zakázky je povinný.");
      return;
    }
    setTitleError(null);

    const jobData = {
      title: formData.title,
      type: formData.type,
      clientSite: formData.clientSite || null,
      address: formData.address || null,
      date: formData.date,
      startTime: formData.startTime || null,
      endTime: formData.endTime || null,
      status: formData.status as JobInputStatus,
      assignedPersonId: formData.assignedPersonId !== "none" ? parseInt(formData.assignedPersonId) : null,
      customerId: formData.customerId,
      notes: formData.notes || null,
      recurrenceIntervalDays:
        formData.type === "service_call" && formData.recurrenceIntervalDays
          ? parseInt(formData.recurrenceIntervalDays)
          : null,
    };

    createJob.mutate({ data: jobData }, {
      onSuccess: async (newJob) => {
        setIsDirty(false);
        invalidateData(queryClient, "jobs", "warehouse");
        for (const title of tasks) {
          await createTask.mutateAsync({ jobId: newJob.id, data: { title } }).catch(() => {});
        }
        for (const m of materials) {
          await createMaterial.mutateAsync({
            jobId: newJob.id,
            data: {
              name: m.name,
              quantity: parseDecimal(m.quantity),
              unit: m.unit || null,
              pricePerUnit: parseDecimal(m.pricePerUnit),
            },
          }).catch(() => {});
        }
        toast({ title: "Zakázka vytvořena" });
        setLocation(`/jobs/${newJob.id}`);
      },
      onError: () => {
        toast({ title: "Nepodařilo se vytvořit zakázku", variant: "destructive" });
      }
    });
  };

  const newMatQtyError = decimalError(newMaterial.quantity);
  const newMatPriceError = decimalError(newMaterial.pricePerUnit);
  const newMatHasErrors = !!(newMatQtyError || newMatPriceError);
  const newMatNamePending = !!newMaterial.name.trim();

  const recurrenceError = formData.type === "service_call"
    ? decimalError(formData.recurrenceIntervalDays, { positiveOnly: true, integerOnly: true })
    : undefined;
  const formHasErrors = !!(newMatHasErrors || newMatNamePending || recurrenceError);

  return (
    <div className="flex flex-col min-h-screen bg-background pb-20 md:pb-0">
      <div className="sticky top-0 z-10 bg-card border-b p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => confirmNavigation(() => window.history.back())}>
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <h1 className="text-xl font-bold flex-1">Nová zakázka</h1>
        <div className="flex flex-col items-end">
          <Button onClick={handleSubmit} disabled={createJob.isPending || formHasErrors} className="h-10 px-4">
            {createJob.isPending ? (
              <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Ukládám…</>
            ) : (
              <><Save className="h-5 w-5 mr-2" /> Uložit</>
            )}
          </Button>
          {createJob.isPending && (
            <p className="text-xs text-muted-foreground mt-1">Ukládám zakázku…</p>
          )}
          {!createJob.isPending && formHasErrors && (
            <p className="text-xs text-destructive mt-1">
              {newMatNamePending && !newMatHasErrors
                ? "Nejprve přidejte rozepsaný materiál"
                : "Opravte chybné pole materiálu"}
            </p>
          )}
        </div>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full flex-1">
        <form onSubmit={handleSubmit} className="space-y-6">

          <div className="space-y-2">
            <Label htmlFor="title" className="text-base">Název zakázky *</Label>
            <Autocomplete
              id="title"
              value={formData.title}
              onValueChange={v => { setFormData(p => ({ ...p, title: v })); markDirty(); if (titleError) setTitleError(null); }}
              suggestions={titleSuggestions}
              placeholder="např. Oprava střechy"
              className={`h-14 text-lg${titleError ? " border-destructive focus-visible:ring-destructive" : ""}`}
              aria-invalid={!!titleError}
              aria-describedby={titleError ? "title-error" : undefined}
            />
            {titleError && (
              <p id="title-error" className="text-destructive text-sm" role="alert">{titleError}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-base">Typ práce</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(JOB_TYPES).map(([key, config]) => {
                const isSelected = formData.type === key;
                const Icon = config.icon;
                return (
                  <div 
                    key={key}
                    onClick={() => handleSelectChange("type", key)}
                    className={`flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                      isSelected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted'
                    }`}
                  >
                    <Icon className={`h-5 w-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className={`text-sm font-medium ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {config.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {formData.type === "service_call" && (
            <div className="space-y-2">
              <Label htmlFor="recurrenceIntervalDays" className="text-base flex items-center gap-1.5">
                <RefreshCw className="h-4 w-4 text-red-500" /> Opakovat servis
              </Label>
              <div className="flex items-start gap-2">
                <span className="text-sm text-muted-foreground mt-3.5">každých</span>
                <div className="flex flex-col">
                  <DecimalInput
                    id="recurrenceIntervalDays"
                    value={formData.recurrenceIntervalDays}
                    onChange={(val) => { setFormData(prev => ({ ...prev, recurrenceIntervalDays: val })); markDirty(); }}
                    placeholder="např. 30"
                    inputMode="numeric"
                    className="h-12 w-28 text-base"
                    error={recurrenceError}
                  />
                </div>
                <span className="text-sm text-muted-foreground mt-3.5">dní</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Po dokončení se automaticky vytvoří další výjezd o tolik dní později. Nechte prázdné pro jednorázový výjezd.
              </p>
            </div>
          )}

          {/* Customer autocomplete */}
          <div className="space-y-2" ref={customerRef}>
            <Label className="text-base flex items-center gap-1.5"><Building2 className="h-4 w-4" /> Zákazník / Stavba</Label>
            {selectedCustomer ? (
              <div className="flex items-center gap-2 h-auto min-h-14 px-4 py-2 rounded-lg border bg-muted/50">
                <Building2 className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{selectedCustomer.companyName}</p>
                  {selectedCustomer.contactPerson && (
                    <p className="text-xs text-muted-foreground truncate">{selectedCustomer.contactPerson}</p>
                  )}
                  {selectedCustomer.phone && (
                    <a href={`tel:${selectedCustomer.phone}`} className="flex items-center gap-1 text-sm text-primary font-medium hover:underline mt-0.5">
                      <Phone className="h-3.5 w-3.5" />
                      {selectedCustomer.phone}
                    </a>
                  )}
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={clearCustomer}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={customerSearch}
                  onChange={e => { setCustomerSearch(e.target.value); setShowCustomerDropdown(true); setFormData(p => ({ ...p, clientSite: e.target.value, customerId: null })); markDirty(); }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  placeholder="Vyhledat nebo zadat adresu..."
                  className="h-14 text-base"
                />
                {showCustomerDropdown && filteredCustomers.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-50 bg-card border rounded-lg shadow-xl mt-1 max-h-48 overflow-y-auto">
                    {filteredCustomers.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted transition-colors border-b last:border-b-0"
                        onClick={() => selectCustomer(c)}
                      >
                        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <p className="font-medium text-sm">{c.companyName}</p>
                          {c.contactPerson && <p className="text-xs text-muted-foreground">{c.contactPerson}</p>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedCustomer && (customerSites?.length ?? 0) > 0 && (
              <div className="space-y-1.5 pt-1">
                <Label className="text-sm flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" /> Stavba / pobočka
                </Label>
                <Select
                  value={selectedSiteId ? String(selectedSiteId) : "none"}
                  onValueChange={(v) => {
                    markDirty();
                    if (v === "none") {
                      setSelectedSiteId(null);
                      setFormData(p => ({ ...p, clientSite: selectedCustomer.companyName }));
                      return;
                    }
                    const site = customerSites?.find(s => String(s.id) === v);
                    if (!site) return;
                    setSelectedSiteId(site.id);
                    setFormData(p => ({
                      ...p,
                      clientSite: `${selectedCustomer.companyName} – ${site.name}`,
                      address: site.address || p.address,
                    }));
                  }}
                >
                  <SelectTrigger className="h-12 text-base">
                    <SelectValue placeholder="Vyberte stavbu / pobočku" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Bez konkrétní stavby —</SelectItem>
                    {customerSites?.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}{s.address ? ` · ${s.address}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="address" className="text-base flex items-center gap-1.5"><Navigation className="h-4 w-4 text-blue-500" /> Adresa stavby (pro navigaci)</Label>
            <Input
              id="address" name="address" value={formData.address} onChange={handleChange}
              placeholder="např. Korunní 47, Praha 2"
              className="h-14 text-base"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleUseCurrentLocation}
              disabled={gpsLoading}
              className="h-12 w-full text-base"
            >
              <LocateFixed className={`h-4 w-4 mr-2 ${gpsLoading ? "animate-pulse" : ""}`} />
              {gpsLoading ? "Zjišťuji polohu…" : "Načíst aktuální polohu (GPS)"}
            </Button>
            {formData.address && (
              <a
                href={`https://waze.com/ul?q=${encodeURIComponent(formData.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-blue-500 hover:underline"
              >
                <Navigation className="h-3.5 w-3.5" /> Otevřít ve Waze
              </a>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date" className="text-base">Datum *</Label>
              <Input id="date" name="date" type="date" value={formData.date} onChange={handleChange} className="h-14 text-base block w-full" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="startTime" className="text-base">Začátek</Label>
              <TimePicker id="startTime" value={formData.startTime} onChange={(v) => { setFormData(prev => ({ ...prev, startTime: v })); markDirty(); }} className="h-14 text-base w-full" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endTime" className="text-base">Konec</Label>
              <TimePicker id="endTime" value={formData.endTime} onChange={(v) => { setFormData(prev => ({ ...prev, endTime: v })); markDirty(); }} className="h-14 text-base w-full" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-base">Přiřadit pracovníkovi</Label>
              <Select value={formData.assignedPersonId} onValueChange={(v) => handleSelectChange("assignedPersonId", v)}>
                <SelectTrigger className="h-14 text-base">
                  <SelectValue placeholder="Vybrat pracovníka" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nepřiřazeno</SelectItem>
                  {people?.map(p => (
                    <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-base">Stav</Label>
              <Select value={formData.status} onValueChange={(v) => handleSelectChange("status", v)}>
                <SelectTrigger className="h-14 text-base">
                  <SelectValue placeholder="Vybrat stav" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(JOB_STATUSES).map(([key, config]) => (
                    <SelectItem key={key} value={key}>{config.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes" className="text-base">Poznámky</Label>
            <Textarea id="notes" name="notes" value={formData.notes} onChange={handleChange} placeholder="Další podrobnosti..." className="min-h-[100px] text-base resize-y" />
          </div>

          {/* Tasks section */}
          <div className="space-y-3 pt-2 border-t">
            <Label className="text-base flex items-center gap-2 pt-2"><CheckSquare className="h-4 w-4" /> Úkoly / checklist</Label>
            <div className="space-y-2">
              {tasks.map((t, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg border">
                  <span className="flex-1 text-sm">{t}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeTask(i)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={newTaskInput}
                onChange={e => { setNewTaskInput(e.target.value); markDirty(); }}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }}
                placeholder="Přidat úkol..."
                className="h-12 text-base"
              />
              <Button type="button" onClick={addTask} disabled={!newTaskInput.trim()} variant="secondary" className="h-12 px-4 shrink-0">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Materials section */}
          <div className="space-y-3 pt-2 border-t">
            <Label className="text-base flex items-center gap-2 pt-2"><ShoppingCart className="h-4 w-4" /> Materiál</Label>
            {materials.length > 0 && (
              <div className="space-y-2">
                {materials.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg border text-sm">
                    <span className="flex-1 font-medium truncate">{m.name}</span>
                    {m.quantity && <span className="text-muted-foreground shrink-0">{m.quantity} {m.unit}</span>}
                    {m.pricePerUnit && <span className="text-muted-foreground shrink-0">{m.pricePerUnit} Kč/ks</span>}
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeMaterial(i)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <Autocomplete
                value={newMaterial.name}
                onValueChange={v => { setNewMaterial(p => ({ ...p, name: v })); markDirty(); }}
                suggestions={materialSuggestions}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addMaterial(); } }}
                placeholder="Název materiálu..."
                className="h-12 text-base"
              />
              <div className="grid grid-cols-3 gap-2">
                <DecimalInput
                  value={newMaterial.quantity}
                  onChange={v => { setNewMaterial(p => ({ ...p, quantity: v })); markDirty(); }}
                  placeholder="Množství"
                  className="h-10"
                  error={newMatQtyError}
                />
                <Input
                  value={newMaterial.unit}
                  onChange={e => { setNewMaterial(p => ({ ...p, unit: e.target.value })); markDirty(); }}
                  placeholder="Jednotka"
                  className="h-10"
                />
                <DecimalInput
                  value={newMaterial.pricePerUnit}
                  onChange={v => { setNewMaterial(p => ({ ...p, pricePerUnit: v })); markDirty(); }}
                  placeholder="Kč/ks"
                  className="h-10"
                  error={newMatPriceError}
                />
              </div>
              <Button type="button" onClick={addMaterial} disabled={!newMaterial.name.trim() || newMatHasErrors} variant="secondary" className="h-11 w-full">
                <Plus className="h-4 w-4 mr-2" /> Přidat materiál
              </Button>
            </div>
          </div>

          <div className="h-12 md:hidden"></div>
        </form>
      </div>
      
      <div className="md:hidden fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-0 right-0 p-4 bg-background border-t">
        <Button onClick={handleSubmit} disabled={createJob.isPending || formHasErrors} className="w-full h-14 text-lg font-bold">
          {createJob.isPending ? (
            <><Loader2 className="h-6 w-6 mr-2 animate-spin" /> Ukládám…</>
          ) : (
            <><Save className="h-6 w-6 mr-2" /> Uložit zakázku</>
          )}
        </Button>
        {createJob.isPending && (
          <p className="text-xs text-muted-foreground text-center mt-2">Ukládám zakázku, počkejte prosím…</p>
        )}
        {!createJob.isPending && formHasErrors && (
          <p className="text-xs text-destructive text-center mt-2">
            {newMatNamePending && !newMatHasErrors
              ? "Nejprve přidejte rozepsaný materiál výše"
              : "Opravte chybné pole materiálu výše"}
          </p>
        )}
      </div>
    </div>
  );
}
