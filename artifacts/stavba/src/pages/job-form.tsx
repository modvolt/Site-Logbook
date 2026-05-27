import { useState, useRef, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { format } from "date-fns";
import { 
  useCreateJob, useListPeople, useCreateTask, 
  useListCustomers,
  getListPeopleQueryKey, getListJobsQueryKey, getListCustomersQueryKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_TYPES, JOB_STATUSES } from "@/components/badges";
import { ArrowLeft, Save, Plus, X, CheckSquare, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function JobForm() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const queryParams = new URLSearchParams(search);
  const initialDate = queryParams.get("date") || format(new Date(), "yyyy-MM-dd");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createJob = useCreateJob();
  const createTask = useCreateTask();
  
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });
  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey() } });

  const [formData, setFormData] = useState({
    title: "",
    type: "planned_work",
    clientSite: "",
    date: initialDate,
    startTime: "",
    endTime: "",
    assignedPersonId: "none",
    status: "planned",
    notes: "",
    customerId: null as number | null,
  });

  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [tasks, setTasks] = useState<string[]>([]);
  const [newTaskInput, setNewTaskInput] = useState("");
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

  const filteredCustomers = customers?.filter(c =>
    c.companyName.toLowerCase().includes(customerSearch.toLowerCase()) ||
    (c.contactPerson || "").toLowerCase().includes(customerSearch.toLowerCase())
  ) || [];

  const selectedCustomer = customers?.find(c => c.id === formData.customerId);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (name: string, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const selectCustomer = (c: NonNullable<typeof customers>[number]) => {
    setFormData(prev => ({ ...prev, customerId: c.id, clientSite: c.companyName }));
    setCustomerSearch(c.companyName);
    setShowCustomerDropdown(false);
  };

  const clearCustomer = () => {
    setFormData(prev => ({ ...prev, customerId: null, clientSite: "" }));
    setCustomerSearch("");
  };

  const addTask = () => {
    if (!newTaskInput.trim()) return;
    setTasks(prev => [...prev, newTaskInput.trim()]);
    setNewTaskInput("");
  };

  const removeTask = (i: number) => setTasks(prev => prev.filter((_, idx) => idx !== i));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      toast({ title: "Název je povinný", variant: "destructive" });
      return;
    }

    const jobData = {
      title: formData.title,
      type: formData.type,
      clientSite: formData.clientSite || null,
      date: formData.date,
      startTime: formData.startTime || null,
      endTime: formData.endTime || null,
      status: formData.status,
      assignedPersonId: formData.assignedPersonId !== "none" ? parseInt(formData.assignedPersonId) : null,
      customerId: formData.customerId,
      notes: formData.notes || null,
    };

    createJob.mutate({ data: jobData }, {
      onSuccess: async (newJob) => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        if (tasks.length > 0) {
          for (const title of tasks) {
            await createTask.mutateAsync({ jobId: newJob.id, data: { title } }).catch(() => {});
          }
        }
        toast({ title: "Zakázka vytvořena" });
        setLocation(`/jobs/${newJob.id}`);
      },
      onError: () => {
        toast({ title: "Nepodařilo se vytvořit zakázku", variant: "destructive" });
      }
    });
  };

  return (
    <div className="flex flex-col min-h-screen bg-background pb-20 md:pb-0">
      <div className="sticky top-0 z-10 bg-card border-b p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()}>
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <h1 className="text-xl font-bold flex-1">Nová zakázka</h1>
        <Button onClick={handleSubmit} disabled={createJob.isPending} className="h-10 px-4">
          <Save className="h-5 w-5 mr-2" /> Uložit
        </Button>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full flex-1">
        <form onSubmit={handleSubmit} className="space-y-6">

          <div className="space-y-2">
            <Label htmlFor="title" className="text-base">Název zakázky *</Label>
            <Input 
              id="title" name="title" value={formData.title} onChange={handleChange} 
              placeholder="např. Oprava střechy" className="h-14 text-lg" autoFocus
            />
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

          {/* Customer autocomplete */}
          <div className="space-y-2" ref={customerRef}>
            <Label className="text-base flex items-center gap-1.5"><Building2 className="h-4 w-4" /> Zákazník / Stavba</Label>
            {selectedCustomer ? (
              <div className="flex items-center gap-2 h-14 px-4 rounded-lg border bg-muted/50">
                <Building2 className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{selectedCustomer.companyName}</p>
                  {selectedCustomer.contactPerson && (
                    <p className="text-xs text-muted-foreground truncate">{selectedCustomer.contactPerson}</p>
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
                  onChange={e => { setCustomerSearch(e.target.value); setShowCustomerDropdown(true); setFormData(p => ({ ...p, clientSite: e.target.value, customerId: null })); }}
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
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date" className="text-base">Datum *</Label>
              <Input id="date" name="date" type="date" value={formData.date} onChange={handleChange} className="h-14 text-base block w-full" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="startTime" className="text-base">Začátek</Label>
              <Input id="startTime" name="startTime" type="time" value={formData.startTime} onChange={handleChange} className="h-14 text-base block w-full" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endTime" className="text-base">Konec</Label>
              <Input id="endTime" name="endTime" type="time" value={formData.endTime} onChange={handleChange} className="h-14 text-base block w-full" />
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
                onChange={e => setNewTaskInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }}
                placeholder="Přidat úkol..."
                className="h-12 text-base"
              />
              <Button type="button" onClick={addTask} disabled={!newTaskInput.trim()} variant="secondary" className="h-12 px-4 shrink-0">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="h-12 md:hidden"></div>
        </form>
      </div>
      
      <div className="md:hidden fixed bottom-16 left-0 right-0 p-4 bg-background border-t">
        <Button onClick={handleSubmit} disabled={createJob.isPending} className="w-full h-14 text-lg font-bold">
          <Save className="h-6 w-6 mr-2" /> Uložit zakázku
        </Button>
      </div>
    </div>
  );
}
