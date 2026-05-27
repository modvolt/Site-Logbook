import { useState, useRef, useCallback, useEffect } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import { 
  useGetJob, getGetJobQueryKey, 
  useUpdateJobStatus, useUpdateJob,
  useListTasks, getListTasksQueryKey, useCreateTask, useUpdateTask, useDeleteTask,
  useListAttachments, getListAttachmentsQueryKey, useCreateAttachment, useDeleteAttachment,
  useListCustomers, getListCustomersQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  ArrowLeft, Clock, MapPin, User, FileText, CheckCircle2, ChevronDown, 
  ChevronUp, Camera, Plus, Trash2, Edit3, Save, X, CreditCard,
  AlertCircle, Phone, Building2, Receipt, FileImage
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { JOB_STATUSES, JOB_TYPES, TypeBadge } from "@/components/badges";

function useSaveFlash() {
  const [saved, setSaved] = useState(false);
  const flash = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  }, []);
  return { saved, flash };
}

export default function JobDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [expandedSection, setExpandedSection] = useState<string | null>("info");
  
  const { data: job, isLoading: loadingJob } = useGetJob(id, {
    query: { enabled: !!id, queryKey: getGetJobQueryKey(id) }
  });
  
  const updateStatus = useUpdateJobStatus();
  
  const toggleSection = (section: string) => {
    setExpandedSection(prev => prev === section ? null : section);
  };

  if (loadingJob) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full space-y-4">
        <Skeleton className="h-12 w-full mb-8" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-8 text-center">Zakázka nenalezena</div>;
  }

  const handleStatusChange = (newStatus: string) => {
    updateStatus.mutate({ id, data: { status: newStatus } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        toast({ title: "Stav změněn" });
      }
    });
  };

  return (
    <div className="flex flex-col min-h-[100dvh] bg-muted/20 pb-20 md:pb-8">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-card border-b shadow-sm">
        <div className="p-4 max-w-3xl mx-auto w-full flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="shrink-0">
              <ArrowLeft className="h-6 w-6" />
            </Button>
            <h1 className="text-xl font-bold flex-1 truncate leading-tight">{job.title}</h1>
            <StatusDropdown currentStatus={job.status} onChange={handleStatusChange} />
          </div>
          
          <div className="flex gap-2 px-12 overflow-x-auto no-scrollbar">
            <TypeBadge type={job.type} />
            <div className="flex items-center text-sm text-muted-foreground font-medium bg-muted px-2 py-0.5 rounded-full">
              <Clock className="w-3.5 h-3.5 mr-1" />
              {format(new Date(job.date), "d.M.yyyy")}
            </div>
            {job.clientSite && (
              <div className="flex items-center text-sm text-muted-foreground font-medium bg-muted px-2 py-0.5 rounded-full whitespace-nowrap">
                <MapPin className="w-3.5 h-3.5 mr-1" />
                {job.clientSite}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 max-w-3xl mx-auto w-full space-y-4">
        <InfoSection job={job} isExpanded={expandedSection === "info"} onToggle={() => toggleSection("info")} />
        <TasksSection jobId={id} isExpanded={expandedSection === "tasks"} onToggle={() => toggleSection("tasks")} />
        <DokladySection jobId={id} isExpanded={expandedSection === "doklady"} onToggle={() => toggleSection("doklady")} />
        <AttachmentsSection jobId={id} isExpanded={expandedSection === "attachments"} onToggle={() => toggleSection("attachments")} />
        <WorkSummarySection job={job} isExpanded={expandedSection === "summary"} onToggle={() => toggleSection("summary")} />
        <CostsSection job={job} isExpanded={expandedSection === "costs"} onToggle={() => toggleSection("costs")} />
      </div>
    </div>
  );
}

function StatusDropdown({ currentStatus, onChange }: { currentStatus: string, onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const config = JOB_STATUSES[currentStatus as keyof typeof JOB_STATUSES];
  const Icon = config?.icon || Clock;

  return (
    <div className="relative">
      <Button 
        onClick={() => setOpen(!open)}
        className={`h-10 px-3 ${config?.color || ''}`}
        variant="outline"
      >
        <Icon className="w-4 h-4 mr-2" />
        {config?.label || currentStatus}
        <ChevronDown className="w-4 h-4 ml-1 opacity-50" />
      </Button>
      
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-52 bg-card border rounded-lg shadow-xl z-40 overflow-hidden">
            {Object.entries(JOB_STATUSES).map(([key, cfg]) => {
              const SIcon = cfg.icon;
              return (
                <button
                  key={key}
                  className={`w-full flex items-center px-4 py-3 text-sm font-medium hover:bg-muted transition-colors ${key === currentStatus ? 'bg-primary/5 text-primary' : ''}`}
                  onClick={() => { onChange(key); setOpen(false); }}
                >
                  <SIcon className="w-4 h-4 mr-3" />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SectionCard({ title, icon: Icon, isExpanded, onToggle, children, summary }: any) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <div 
        className="px-4 py-4 flex items-center justify-between cursor-pointer hover:bg-muted/50 transition-colors bg-card"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg text-primary">
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-lg">{title}</h3>
            {summary && !isExpanded && <p className="text-sm text-muted-foreground mt-0.5">{summary}</p>}
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-5 h-5 text-muted-foreground" /> : <ChevronDown className="w-5 h-5 text-muted-foreground" />}
      </div>
      
      {isExpanded && (
        <div className="border-t bg-card">
          {children}
        </div>
      )}
    </Card>
  );
}

function InfoSection({ job, isExpanded, onToggle }: any) {
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(job.notes || "");

  const [editingCustomer, setEditingCustomer] = useState(false);
  const [customerSearch, setCustomerSearch] = useState(job.clientSite || "");
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(job.customerId || null);
  const [showDropdown, setShowDropdown] = useState(false);
  const customerDropRef = useRef<HTMLDivElement>(null);

  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() }
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerDropRef.current && !customerDropRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filteredCustomers = customers?.filter(c =>
    c.companyName.toLowerCase().includes(customerSearch.toLowerCase()) ||
    (c.contactPerson || "").toLowerCase().includes(customerSearch.toLowerCase())
  ) || [];

  const saveNotes = () => {
    updateJob.mutate({ id: job.id, data: { notes } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        setEditingNotes(false);
        toast({ title: "Poznámky uloženy" });
      }
    });
  };

  const saveCustomer = () => {
    updateJob.mutate({ id: job.id, data: { clientSite: customerSearch || null, customerId: selectedCustomerId } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        setEditingCustomer(false);
        toast({ title: "Zákazník uložen" });
      }
    });
  };

  return (
    <SectionCard 
      title="Detaily zakázky" 
      icon={FileText} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={job.notes ? "Obsahuje poznámky" : "Bez poznámek"}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-y-4 gap-x-2 text-sm">
          <div>
            <p className="text-muted-foreground mb-1 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Datum a čas</p>
            <p className="font-medium">{format(new Date(job.date), "d.M.yyyy")}</p>
            {(job.startTime || job.endTime) && (
              <p className="text-muted-foreground">{job.startTime || '?'} – {job.endTime || '?'}</p>
            )}
          </div>
          <div>
            <p className="text-muted-foreground mb-1 flex items-center gap-1"><User className="w-3.5 h-3.5" /> Přiřazeno</p>
            <p className="font-medium">{job.assignedPersonName || "Nepřiřazeno"}</p>
          </div>
          
          {/* Customer / Site editable */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-muted-foreground flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Zákazník / Stavba</p>
              {!editingCustomer ? (
                <Button variant="ghost" size="sm" onClick={() => { setEditingCustomer(true); setCustomerSearch(job.clientSite || ""); setSelectedCustomerId(job.customerId || null); }} className="h-7 text-xs">
                  <Edit3 className="w-3 h-3 mr-1" /> Upravit
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditingCustomer(false)} className="h-7 w-7 p-0"><X className="w-3.5 h-3.5" /></Button>
                  <Button size="sm" onClick={saveCustomer} disabled={updateJob.isPending} className="h-7 px-2 text-xs"><Save className="w-3 h-3 mr-1" /> Uložit</Button>
                </div>
              )}
            </div>
            
            {editingCustomer ? (
              <div ref={customerDropRef} className="relative">
                <Input
                  value={customerSearch}
                  onChange={e => { setCustomerSearch(e.target.value); setShowDropdown(true); setSelectedCustomerId(null); }}
                  onFocus={() => setShowDropdown(true)}
                  placeholder="Hledat zákazníka nebo zadat adresu..."
                  className="h-11 text-sm"
                  autoFocus
                />
                {selectedCustomerId && (
                  <div className="flex items-center gap-1 mt-1">
                    <Building2 className="w-3 h-3 text-primary" />
                    <span className="text-xs text-primary font-medium">{customers?.find(c => c.id === selectedCustomerId)?.companyName}</span>
                    <button onClick={() => { setSelectedCustomerId(null); }} className="text-muted-foreground hover:text-destructive ml-1"><X className="w-3 h-3" /></button>
                  </div>
                )}
                {showDropdown && filteredCustomers.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-50 bg-card border rounded-lg shadow-xl mt-1 max-h-40 overflow-y-auto">
                    {filteredCustomers.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted transition-colors border-b last:border-b-0"
                        onClick={() => { setSelectedCustomerId(c.id); setCustomerSearch(c.companyName); setShowDropdown(false); }}
                      >
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div>
                          <p className="font-medium text-sm">{c.companyName}</p>
                          {c.contactPerson && <p className="text-xs text-muted-foreground">{c.contactPerson}</p>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className="font-medium">{job.clientSite || "Nezadáno"}</p>
                {job.customerCompanyName && (
                  <div className="flex items-center gap-2 mt-1">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">{job.customerCompanyName}</span>
                    {job.customerPhone && (
                      <a href={`tel:${job.customerPhone}`} className="flex items-center gap-1 text-primary font-medium hover:underline ml-1">
                        <Phone className="w-3.5 h-3.5" />
                        {job.customerPhone}
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="pt-4 border-t">
          <div className="flex justify-between items-center mb-2">
            <p className="font-bold">Poznámky</p>
            {!editingNotes ? (
              <Button variant="ghost" size="sm" onClick={() => setEditingNotes(true)} className="h-8">
                <Edit3 className="w-4 h-4 mr-2" /> Upravit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setEditingNotes(false); setNotes(job.notes || ""); }} className="h-8">
                  <X className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={saveNotes} disabled={updateJob.isPending} className="h-8">
                  <Save className="w-4 h-4 mr-2" /> Uložit
                </Button>
              </div>
            )}
          </div>
          
          {editingNotes ? (
            <Textarea 
              value={notes} 
              onChange={e => setNotes(e.target.value)} 
              className="min-h-[100px] text-base"
              placeholder="Přidat poznámky..."
              autoFocus
            />
          ) : (
            <div className="bg-muted/30 p-3 rounded-lg min-h-[80px] text-sm whitespace-pre-wrap">
              {job.notes || <span className="text-muted-foreground italic">Žádné poznámky.</span>}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function TasksSection({ jobId, isExpanded, onToggle }: any) {
  const { data: tasks } = useListTasks(jobId, {
    query: { enabled: isExpanded, queryKey: getListTasksQueryKey(jobId) }
  });
  
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createAttachment = useCreateAttachment();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [isChange, setIsChange] = useState(false);

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    createTask.mutate({ jobId, data: { title: newTaskTitle, isChangeRequest: isChange } }, {
      onSuccess: () => {
        setNewTaskTitle("");
        setIsChange(false);
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) });
      }
    });
  };

  const handleToggleTask = (taskId: number, done: boolean) => {
    updateTask.mutate({ jobId, taskId, data: { done } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })
    });
  };

  const handleDeleteTask = (taskId: number) => {
    if (!confirm("Smazat tento úkol?")) return;
    deleteTask.mutate({ jobId, taskId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })
    });
  };

  const handleUpdateTask = (taskId: number, data: { title?: string; description?: string }) => {
    updateTask.mutate({ jobId, taskId, data }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })
    });
  };

  const handleTaskPhoto = (taskId: number, file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target?.result as string;
      createAttachment.mutate({ jobId, data: { type: "photo", fileName: file.name, url, description: `Foto k úkolu` } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) });
          toast({ title: "Fotografie uložena" });
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const regularTasks = tasks?.filter(t => !t.isChangeRequest) || [];
  const changeRequests = tasks?.filter(t => t.isChangeRequest) || [];

  const doneCount = tasks?.filter(t => t.done).length || 0;
  const totalCount = tasks?.length || 0;
  const summary = totalCount > 0 ? `${doneCount}/${totalCount} hotovo` : "Žádné úkoly";

  return (
    <SectionCard 
      title="Úkoly a checklist" 
      icon={CheckCircle2} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={summary}
    >
      <div className="p-4 space-y-6">
        <form onSubmit={handleAddTask} className="space-y-3">
          <div className="flex gap-2">
            <Input 
              value={newTaskTitle} 
              onChange={e => setNewTaskTitle(e.target.value)} 
              placeholder="Přidat nový úkol..." 
              className="h-12 text-base flex-1 bg-background"
            />
            <Button type="submit" disabled={!newTaskTitle.trim() || createTask.isPending} className="h-12 px-6">
              <Plus className="w-5 h-5" />
            </Button>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox id="isChange" checked={isChange} onCheckedChange={(c) => setIsChange(!!c)} className="w-5 h-5" />
            <label htmlFor="isChange" className="text-sm font-medium leading-none flex items-center">
              Označit jako vícepráce <AlertCircle className="w-3.5 h-3.5 ml-1.5 text-indigo-500" />
            </label>
          </div>
        </form>

        {regularTasks.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Úkoly</h4>
            <div className="space-y-1">
              {regularTasks.map(task => (
                <TaskRow key={task.id} task={task} jobId={jobId} onToggle={handleToggleTask} onDelete={handleDeleteTask} onUpdate={handleUpdateTask} onTaskPhoto={handleTaskPhoto} />
              ))}
            </div>
          </div>
        )}

        {changeRequests.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-indigo-600 uppercase tracking-wider flex items-center">
              <AlertCircle className="w-4 h-4 mr-1" /> Vícepráce
            </h4>
            <div className="space-y-1 bg-indigo-50/50 dark:bg-indigo-950/20 p-2 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
              {changeRequests.map(task => (
                <TaskRow key={task.id} task={task} jobId={jobId} onToggle={handleToggleTask} onDelete={handleDeleteTask} onUpdate={handleUpdateTask} onTaskPhoto={handleTaskPhoto} isChangeRequest />
              ))}
            </div>
          </div>
        )}
        
        {totalCount === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            Zatím žádné úkoly.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function TaskRow({ task, onToggle, onDelete, onUpdate, onTaskPhoto, isChangeRequest = false }: {
  task: any;
  jobId: number;
  onToggle: (id: number, done: boolean) => void;
  onDelete: (id: number) => void;
  onUpdate: (id: number, data: { title?: string; description?: string }) => void;
  onTaskPhoto: (id: number, file: File) => void;
  isChangeRequest?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description || "");

  const saveEdit = () => {
    if (editTitle.trim()) {
      onUpdate(task.id, { title: editTitle.trim(), description: editDesc.trim() || undefined });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="p-3 bg-card border rounded-lg space-y-2">
        <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="h-10 text-sm font-medium" autoFocus />
        {isChangeRequest && (
          <Textarea 
            value={editDesc} 
            onChange={e => setEditDesc(e.target.value)} 
            placeholder="Popis materiálu / práce..."
            className="min-h-[60px] text-sm resize-none"
          />
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={saveEdit} className="h-8 text-xs px-3"><Save className="w-3.5 h-3.5 mr-1" /> Uložit</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-8 text-xs px-2"><X className="w-3.5 h-3.5" /></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 p-3 bg-card border rounded-lg hover:bg-muted/50 transition-colors">
      <Checkbox 
        checked={task.done} 
        onCheckedChange={(c) => onToggle(task.id, !!c)} 
        className="mt-0.5 w-6 h-6 rounded-full border-2 data-[state=checked]:bg-green-500 data-[state=checked]:border-green-500 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className={`text-base ${task.done ? 'line-through text-muted-foreground' : 'font-medium'}`}>
          {task.title}
        </div>
        {task.description && (
          <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">{task.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isChangeRequest && (
          <Button 
            variant="ghost" size="icon"
            onClick={() => setEditing(true)}
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            <Edit3 className="w-4 h-4" />
          </Button>
        )}
        <input 
          type="file" accept="image/*" capture="environment" ref={cameraRef}
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onTaskPhoto(task.id, f); }}
        />
        <Button 
          variant="ghost" size="icon"
          onClick={() => cameraRef.current?.click()}
          className="h-9 w-9 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
        >
          <Camera className="w-4 h-4" />
        </Button>
        <div className="w-1" />
        <Button 
          variant="ghost" size="icon"
          onClick={() => onDelete(task.id)} 
          className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function DokladySection({ jobId, isExpanded, onToggle }: any) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: attachments } = useListAttachments(jobId, {
    query: { enabled: isExpanded, queryKey: getListAttachmentsQueryKey(jobId) }
  });
  
  const createAttachment = useCreateAttachment();
  const deleteAttachment = useDeleteAttachment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const doklady = attachments?.filter(a => ["invoice", "receipt", "delivery_note"].includes(a.type)) || [];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const url = event.target?.result as string;
      const type = file.type.startsWith("image/") ? "receipt" : "invoice";
      createAttachment.mutate({ jobId, data: { type, fileName: file.name, url } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) });
          toast({ title: "Doklad uložen" });
        }
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleDelete = (id: number) => {
    if (!confirm("Smazat tento doklad?")) return;
    deleteAttachment.mutate({ jobId, attachmentId: id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })
    });
  };

  return (
    <SectionCard
      title="Doklady"
      icon={Receipt}
      isExpanded={isExpanded}
      onToggle={onToggle}
      summary={doklady.length > 0 ? `${doklady.length} dokladů` : "Žádné doklady"}
    >
      <div className="p-4 space-y-4">
        <input 
          type="file" 
          accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png"
          capture="environment"
          ref={fileInputRef} 
          onChange={handleFileUpload} 
          className="hidden" 
        />
        <div className="flex gap-2">
          <Button 
            onClick={() => fileInputRef.current?.click()} 
            disabled={createAttachment.isPending}
            variant="secondary"
            className="flex-1 h-12 text-base"
          >
            <Camera className="w-5 h-5 mr-2" /> Vyfotit / nahrát doklad
          </Button>
        </div>

        {doklady.length > 0 && (
          <div className="space-y-2">
            {doklady.map(doc => (
              <div key={doc.id} className="flex items-center gap-3 p-3 bg-muted/40 border rounded-lg group">
                <div className="p-1.5 bg-amber-100 dark:bg-amber-900/30 rounded text-amber-600 dark:text-amber-400 shrink-0">
                  <FileImage className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{doc.fileName || "Doklad"}</p>
                  <p className="text-xs text-muted-foreground capitalize">{doc.type === "invoice" ? "Faktura" : doc.type === "receipt" ? "Účtenka" : "Dodací list"}</p>
                </div>
                {doc.url && doc.url.startsWith("data:image") && (
                  <a href={doc.url} target="_blank" rel="noopener" className="text-xs text-primary hover:underline shrink-0">Zobrazit</a>
                )}
                <Button 
                  variant="ghost" size="icon" 
                  className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={() => handleDelete(doc.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {doklady.length === 0 && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Receipt className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Přidejte faktury, účtenky nebo dodací listy.</p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function AttachmentsSection({ jobId, isExpanded, onToggle }: any) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: attachments } = useListAttachments(jobId, {
    query: { enabled: isExpanded, queryKey: getListAttachmentsQueryKey(jobId) }
  });
  
  const createAttachment = useCreateAttachment();
  const deleteAttachment = useDeleteAttachment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Url = event.target?.result as string;
      createAttachment.mutate({ 
        jobId, 
        data: { type: "photo", fileName: file.name, url: base64Url, description: "Foto ze stavby" } 
      }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) });
          toast({ title: "Fotografie uložena" });
        }
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleDelete = (attachmentId: number) => {
    if (!confirm("Smazat tuto fotografii?")) return;
    deleteAttachment.mutate({ jobId, attachmentId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })
    });
  };

  const photos = attachments?.filter(a => a.type === "photo") || [];
  
  return (
    <SectionCard 
      title="Fotodokumentace" 
      icon={Camera} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={photos.length > 0 ? `${photos.length} fotek` : "Žádné fotky"}
    >
      <div className="p-4 space-y-6">
        <div className="flex gap-3">
          <input 
            type="file" accept="image/*" capture="environment" 
            ref={fileInputRef} onChange={handlePhotoCapture} className="hidden" 
          />
          <Button 
            onClick={() => fileInputRef.current?.click()} 
            disabled={createAttachment.isPending}
            className="flex-1 h-14 bg-primary text-primary-foreground text-base"
          >
            <Camera className="w-5 h-5 mr-2" /> Vyfotit stavbu
          </Button>
        </div>

        {photos.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {photos.map(photo => (
              <div key={photo.id} className="relative aspect-square rounded-xl overflow-hidden border group bg-muted">
                {photo.url ? (
                  <img src={photo.url} alt={photo.fileName || "Fotografie"} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                    <Camera className="w-8 h-8 opacity-20" />
                  </div>
                )}
                <button 
                  onClick={() => handleDelete(photo.id)}
                  className="absolute top-2 right-2 p-1.5 bg-background/80 backdrop-blur-sm rounded-full text-destructive shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        
        {photos.length === 0 && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Camera className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p>Foťte průběh prací, stav stavby apod.</p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function WorkSummarySection({ job, isExpanded, onToggle }: any) {
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { saved, flash } = useSaveFlash();
  
  const [hoursVasek, setHoursVasek] = useState(job.hoursVasek?.toString() || "");
  const [hoursJonas, setHoursJonas] = useState(job.hoursJonas?.toString() || "");
  const [price, setPrice] = useState(job.price?.toString() || "");

  const totalHours = (parseFloat(hoursVasek) || 0) + (parseFloat(hoursJonas) || 0);

  const handleSave = () => {
    updateJob.mutate({ 
      id: job.id, 
      data: { 
        hoursVasek: hoursVasek ? parseFloat(hoursVasek) : null,
        hoursJonas: hoursJonas ? parseFloat(hoursJonas) : null,
        hoursSpent: totalHours || null,
        price: price ? parseFloat(price) : null
      } 
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        flash();
        toast({ title: "Souhrn uložen" });
      }
    });
  };

  const summary = (job.hoursVasek || job.hoursJonas || job.price)
    ? `${totalHours.toFixed(1) !== "0.0" ? totalHours.toFixed(1) + "h" : ""} ${job.price ? "• " + Number(job.price).toLocaleString("cs-CZ") + " Kč" : ""}`.trim()
    : "Nevyplněno";

  return (
    <SectionCard 
      title="Souhrn práce" 
      icon={Clock} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={summary}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Vašek (h)</label>
            <div className="relative">
              <Input 
                type="number" step="0.5" value={hoursVasek} 
                onChange={e => setHoursVasek(e.target.value)} 
                className="h-14 text-lg pl-4 pr-10" placeholder="0.0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">h</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Jonáš (h)</label>
            <div className="relative">
              <Input 
                type="number" step="0.5" value={hoursJonas} 
                onChange={e => setHoursJonas(e.target.value)} 
                className="h-14 text-lg pl-4 pr-10" placeholder="0.0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">h</span>
            </div>
          </div>
        </div>
        
        {(parseFloat(hoursVasek) > 0 || parseFloat(hoursJonas) > 0) && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg">
            Celkem: <span className="font-semibold text-foreground">{totalHours.toFixed(1)} h</span>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-bold text-muted-foreground">Cena za práci (Kč) — volitelné</label>
          <div className="relative">
            <Input 
              type="number" step="1" value={price} 
              onChange={e => setPrice(e.target.value)} 
              className="h-14 text-lg pr-14" placeholder="0"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">Kč</span>
          </div>
        </div>

        <Button 
          onClick={handleSave} 
          disabled={updateJob.isPending} 
          className={`w-full h-12 transition-colors ${saved ? "bg-green-500 hover:bg-green-500 text-white" : ""}`}
        >
          <Save className="w-5 h-5 mr-2" /> {saved ? "Uloženo ✓" : "Uložit souhrn"}
        </Button>
      </div>
    </SectionCard>
  );
}

function CostsSection({ job, isExpanded, onToggle }: any) {
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { saved, flash } = useSaveFlash();
  
  const [costs, setCosts] = useState({
    transportKm: job.transportKm?.toString() || "",
    fines: job.fines?.toString() || "",
    parking: job.parking?.toString() || ""
  });

  const handleSave = () => {
    const data = {
      transportKm: costs.transportKm ? parseFloat(costs.transportKm) : null,
      fines: costs.fines ? parseFloat(costs.fines) : null,
      parking: costs.parking ? parseFloat(costs.parking) : null,
    };
    
    updateJob.mutate({ id: job.id, data }, {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), updated);
        flash();
        toast({ title: "Výdaje uloženy" });
      }
    });
  };

  const hasCosts = job.transportKm || job.fines || job.parking;

  const costsLabel = hasCosts
    ? [
        job.transportKm ? `${Number(job.transportKm)} km` : null,
        job.parking ? `P: ${Number(job.parking).toLocaleString("cs-CZ")} Kč` : null,
        job.fines ? `Pok.: ${Number(job.fines).toLocaleString("cs-CZ")} Kč` : null,
      ].filter(Boolean).join(" • ")
    : "Žádné výdaje";

  return (
    <SectionCard 
      title="Cestovní výdaje" 
      icon={CreditCard} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={costsLabel}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Vzdálenost</label>
            <div className="relative">
              <Input 
                type="number" 
                value={costs.transportKm} 
                onChange={e => setCosts(prev => ({...prev, transportKm: e.target.value}))} 
                className="h-14 text-base pr-12" 
                placeholder="0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-medium">km</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Parkování (Kč)</label>
            <div className="relative">
              <Input 
                type="number" 
                value={costs.parking} 
                onChange={e => setCosts(prev => ({...prev, parking: e.target.value}))} 
                className="h-14 text-base pr-12" 
                placeholder="0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">Kč</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Pokuty (Kč)</label>
            <div className="relative">
              <Input 
                type="number" 
                value={costs.fines} 
                onChange={e => setCosts(prev => ({...prev, fines: e.target.value}))} 
                className="h-14 text-base pr-12" 
                placeholder="0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">Kč</span>
            </div>
          </div>
        </div>
        <Button 
          onClick={handleSave} 
          disabled={updateJob.isPending} 
          variant="secondary"
          className={`w-full h-12 transition-colors ${saved ? "bg-green-500 hover:bg-green-500 text-white" : ""}`}
        >
          <Save className="w-5 h-5 mr-2" /> {saved ? "Uloženo ✓" : "Uložit výdaje"}
        </Button>
      </div>
    </SectionCard>
  );
}
