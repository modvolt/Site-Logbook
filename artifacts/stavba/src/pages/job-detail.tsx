import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { format } from "date-fns";
import { 
  useGetJob, getGetJobQueryKey,
  useUpdateJobStatus, useUpdateJob, useDeleteJob,
  useListTasks, getListTasksQueryKey, useCreateTask, useUpdateTask, useDeleteTask,
  useListAttachments, getListAttachmentsQueryKey, useCreateAttachment, useDeleteAttachment,
  useListMaterials, getListMaterialsQueryKey, useCreateMaterial, useUpdateMaterial, useDeleteMaterial,
  useListWarehouseItems, getListWarehouseItemsQueryKey,
  useListCustomers, getListCustomersQueryKey,
  useListJobTimeEntries, getListJobTimeEntriesQueryKey,
  useCreateJobTimeEntry, useStartJobTimeEntry, useStopJobTimeEntry,
  useUpdateJobTimeEntry, useDeleteJobTimeEntry,
  useListPeople, getListPeopleQueryKey,
  useAnalyzeJobDocuments,
} from "@workspace/api-client-react";
import { TimeEntriesSection } from "@/components/time-entries-section";
import { useAuth } from "@/hooks/use-auth";
import { useUpload } from "@workspace/object-storage-web";
import { UploadProgressBar } from "@/components/upload-progress-bar";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { 
  ArrowLeft, Clock, MapPin, User, FileText, CheckCircle2, ChevronDown, 
  ChevronUp, Camera, Plus, Trash2, Edit3, Save, X, CreditCard,
  AlertCircle, Phone, Building2, Receipt, FileImage, Navigation, ShoppingCart, Play, Square, CalendarPlus, RotateCcw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Autocomplete } from "@/components/autocomplete";
import { TimePicker } from "@/components/time-picker";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COST_DOC_TYPE_LABELS } from "@/lib/cost-document-format";
import { useToast } from "@/hooks/use-toast";
import { debugLog } from "@/lib/pwa";
import { JOB_STATUSES, JOB_TYPES, TypeBadge } from "@/components/badges";
import { AttachmentViewer } from "@/components/attachment-viewer";
import { FileDropZone } from "@/components/file-drop-zone";
import { prepareImageFile } from "@/lib/prepare-image";
import { computeTimerHours, hoursFromPresetTimes } from "@/pages/dashboard";
import {
  ensureNotificationPermission,
  showTimerNotification,
  clearTimerNotification,
} from "@/lib/timer-notification";
import { invalidateData } from "@/lib/query-invalidation";

// Po změně zakázky obnoví seznamy, kalendář, dashboard i statistiky – uživatel
// nikdy nemusí obnovovat ručně. Vazby viz @/lib/query-invalidation.
function invalidateJobLists(queryClient: QueryClient) {
  invalidateData(queryClient, "jobs");
}


function getAttachmentUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:")) return url;
  return `/api/storage${url}`;
}

function useSaveFlash() {
  const [saved, setSaved] = useState(false);
  const flash = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  }, []);
  return { saved, flash };
}

function useJobTimer(timerStartedAt: string | null | undefined) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!timerStartedAt) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(timerStartedAt).getTime()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [timerStartedAt]);
  return elapsed;
}

function formatElapsed(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export default function JobDetail() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = parseInt(params.id || "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [expandedSection, setExpandedSection] = useState<string | null>("info");
  
  const { data: job, isLoading: loadingJob } = useGetJob(id, {
    query: { enabled: !!id, queryKey: getGetJobQueryKey(id) }
  });
  
  const updateStatus = useUpdateJobStatus();
  const updateJob = useUpdateJob();
  const deleteJob = useDeleteJob();

  const elapsed = useJobTimer(job?.timerStartedAt);
  const isTimerRunning = !!job?.timerStartedAt;

  useEffect(() => {
    if (job?.timerStartedAt) void showTimerNotification(job?.title ?? "");
  }, [job?.id, job?.timerStartedAt, job?.title]);
  
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
        invalidateJobLists(queryClient);
        toast({ title: "Stav změněn" });
      }
    });
  };

  const handleTimerStart = async () => {
    const notify = await ensureNotificationPermission();
    updateJob.mutate({ id, data: { timerStartedAt: new Date().toISOString(), status: "in_progress" } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        invalidateJobLists(queryClient);
        if (notify) void showTimerNotification(job?.title ?? "");
        toast({ title: "Měření času spuštěno" });
      }
    });
  };

  const handleTimerStop = () => {
    const { newTotal, added, belowThreshold } = computeTimerHours(elapsed, job?.hoursSpent);
    // Only count as a new actual measurement (and drop the plan revert option) when time was actually added
    const data = belowThreshold
      ? { timerStartedAt: null }
      : { timerStartedAt: null, hoursSpent: newTotal || null, hoursFromPlan: false, hoursBeforePlan: null };
    updateJob.mutate({ id, data }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        invalidateJobLists(queryClient);
        void clearTimerNotification();
        toast({
          title: belowThreshold
            ? `Čas zastaven — pod 5 min, nezapočítáno`
            : `Čas zastaven — +${added.toFixed(2)} h (celkem ${newTotal.toFixed(2)} h)`,
        });
      }
    });
  };

  const handleDeleteJob = () => {
    if (!confirm(`Opravdu smazat zakázku „${job?.title}"? Tato akce je nevratná.`)) return;
    deleteJob.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });
        invalidateJobLists(queryClient);
        toast({ title: "Zakázka smazána" });
        setLocation("/jobs");
      },
      onError: () => {
        toast({ title: "Nepodařilo se smazat zakázku", variant: "destructive" });
      }
    });
  };

  const handleUsePresetTime = () => {
    const hours = hoursFromPresetTimes(job?.startTime, job?.endTime);
    if (!hours) return;
    const previousActual = job?.hoursSpent != null ? Number(job.hoursSpent) : null;
    updateJob.mutate({ id, data: { hoursSpent: hours, hoursFromPlan: true, hoursBeforePlan: previousActual } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        invalidateJobLists(queryClient);
        toast({ title: `Uloženo ${hours.toFixed(2)} h podle plánu (${job.startTime}–${job.endTime})` });
      }
    });
  };

  const handleRevertToActual = () => {
    const restored = job?.hoursBeforePlan != null ? Number(job.hoursBeforePlan) : null;
    updateJob.mutate({ id, data: { hoursSpent: restored, hoursFromPlan: false, hoursBeforePlan: null } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        invalidateJobLists(queryClient);
        toast({
          title: restored != null
            ? `Vráceno na skutečný čas (${restored.toFixed(2)} h)`
            : "Vráceno na skutečný čas",
        });
      }
    });
  };

  const handleAddVisit = () => {
    const params = new URLSearchParams();
    params.set("date", format(new Date(), "yyyy-MM-dd"));
    if (job.customerId) params.set("customerId", job.customerId.toString());
    if (job.clientSite) params.set("clientSite", job.clientSite);
    setLocation(`/jobs/new?${params.toString()}`);
  };

  return (
    <div className="flex flex-col min-h-[100dvh] bg-muted/20 pb-20 md:pb-8">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-card border-b shadow-sm">
        {isTimerRunning && (
          <div className="bg-green-500 text-white px-4 py-1.5 flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> Měření času probíhá
            </span>
            <span className="font-mono font-bold">{formatElapsed(elapsed)}</span>
          </div>
        )}
        <div className="p-4 max-w-3xl mx-auto w-full flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="shrink-0">
              <ArrowLeft className="h-6 w-6" />
            </Button>
            <h1 className="text-xl font-bold flex-1 truncate leading-tight">{job.title}</h1>
            <StatusDropdown currentStatus={job.status} onChange={handleStatusChange} />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDeleteJob}
              disabled={deleteJob.isPending}
              className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
              title="Smazat zakázku"
            >
              <Trash2 className="h-5 w-5" />
            </Button>
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

          {/* Timer + Visit controls */}
          <div className="flex gap-2 px-1 flex-wrap">
            {isTimerRunning ? (
              <Button onClick={handleTimerStop} disabled={updateJob.isPending} variant="destructive" className="flex-1 h-10 text-sm min-w-[140px]">
                <Square className="w-4 h-4 mr-2 fill-current" /> Zastavit čas ({formatElapsed(elapsed)})
              </Button>
            ) : (
              <>
                <Button onClick={handleTimerStart} disabled={updateJob.isPending} className="flex-1 h-10 text-sm bg-green-600 hover:bg-green-700 text-white min-w-[120px]">
                  <Play className="w-4 h-4 mr-2 fill-current" /> Spustit čas
                </Button>
                {job.hoursFromPlan ? (
                  <Button
                    onClick={handleRevertToActual}
                    disabled={updateJob.isPending}
                    variant="outline"
                    className="flex-1 h-10 text-sm border-amber-300 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/20 min-w-[160px]"
                    title="Vrátit zpět na dříve naměřený skutečný čas"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" /> Zpět na skutečný čas
                  </Button>
                ) : (() => {
                  const planHours = hoursFromPresetTimes(job.startTime, job.endTime);
                  if (!planHours) return null;
                  return (
                    <Button
                      onClick={handleUsePresetTime}
                      disabled={updateJob.isPending}
                      variant="outline"
                      className="flex-1 h-10 text-sm border-blue-300 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/20 min-w-[140px]"
                      title={`Použít naplánovaný čas ${job.startTime}–${job.endTime}`}
                    >
                      <Clock className="w-4 h-4 mr-2" /> Plán ({planHours.toFixed(2)} h)
                    </Button>
                  );
                })()}
              </>
            )}
            <Button onClick={handleAddVisit} variant="outline" className="h-10 px-3 text-sm border-violet-300 text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/20">
              <CalendarPlus className="w-4 h-4 mr-1.5" /> Výjezd
            </Button>
          </div>
          {!isTimerRunning && job.hoursSpent != null && Number(job.hoursSpent) > 0 && (
            <div className="px-1 text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
              <Clock className="w-3.5 h-3.5" />
              Strávený čas: <span className="font-bold text-foreground">{Number(job.hoursSpent).toFixed(2)} h</span>
              {job.hoursFromPlan && (
                <span className="text-xs font-medium text-blue-600 bg-blue-50 dark:bg-blue-950/20 px-1.5 py-0.5 rounded-full">
                  dle plánu
                </span>
              )}
              <span className="text-xs">(editovatelné v Souhrnu práce)</span>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 max-w-3xl mx-auto w-full space-y-4">
        <Button
          variant="outline"
          onClick={() => setLocation(`/jobs/${id}/list`)}
          className="w-full h-11 border-primary/40 text-primary hover:bg-primary/5"
        >
          <FileText className="w-4 h-4 mr-2" /> Zakázkový list (PDF / e-mail)
        </Button>
        <InfoSection job={job} isExpanded={expandedSection === "info"} onToggle={() => toggleSection("info")} />
        <DokladySection jobId={id} isExpanded={expandedSection === "doklady"} onToggle={() => toggleSection("doklady")} />
        <AttachmentsSection jobId={id} isExpanded={expandedSection === "attachments"} onToggle={() => toggleSection("attachments")} />
        <TasksSection jobId={id} isExpanded={expandedSection === "tasks"} onToggle={() => toggleSection("tasks")} />
        <MaterialsSection jobId={id} isExpanded={expandedSection === "materials"} onToggle={() => toggleSection("materials")} />
        <JobTimeEntries jobId={id} />
        <JobSheetsSection jobId={id} isExpanded={expandedSection === "jobsheets"} onToggle={() => toggleSection("jobsheets")} />
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
  const [, navigate] = useLocation();
  
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(job.notes || "");

  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState(job.address || "");

  const [editingDate, setEditingDate] = useState(false);
  const [dateDraft, setDateDraft] = useState(job.date || "");
  const [startTimeDraft, setStartTimeDraft] = useState(job.startTime || "");
  const [endTimeDraft, setEndTimeDraft] = useState(job.endTime || "");

  const saveDate = () => {
    if (!dateDraft) {
      toast({ title: "Datum je povinné", variant: "destructive" });
      return;
    }
    updateJob.mutate({ id: job.id, data: { date: dateDraft, startTime: startTimeDraft || null, endTime: endTimeDraft || null } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        invalidateJobLists(queryClient);
        setEditingDate(false);
        toast({ title: "Datum a čas uloženy" });
      }
    });
  };

  const saveAddress = () => {
    updateJob.mutate({ id: job.id, data: { address: addressDraft || null } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        invalidateJobLists(queryClient);
        setEditingAddress(false);
        toast({ title: "Adresa uložena" });
      }
    });
  };

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
        invalidateJobLists(queryClient);
        setEditingNotes(false);
        toast({ title: "Poznámky uloženy" });
      }
    });
  };

  const saveCustomer = () => {
    updateJob.mutate({ id: job.id, data: { clientSite: customerSearch || null, customerId: selectedCustomerId } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        invalidateJobLists(queryClient);
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
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-muted-foreground flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Datum a čas</p>
              {!editingDate ? (
                <Button variant="ghost" size="sm" onClick={() => { setEditingDate(true); setDateDraft(job.date || ""); setStartTimeDraft(job.startTime || ""); setEndTimeDraft(job.endTime || ""); }} className="h-7 text-xs">
                  <Edit3 className="w-3 h-3 mr-1" /> Upravit
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditingDate(false)} className="h-7 w-7 p-0"><X className="w-3.5 h-3.5" /></Button>
                  <Button size="sm" onClick={saveDate} disabled={updateJob.isPending} className="h-7 px-2 text-xs"><Save className="w-3 h-3 mr-1" /> Uložit</Button>
                </div>
              )}
            </div>
            {editingDate ? (
              <div className="grid grid-cols-3 gap-2">
                <Input type="date" value={dateDraft} onChange={e => setDateDraft(e.target.value)} className="h-10 text-sm" />
                <TimePicker value={startTimeDraft} onChange={setStartTimeDraft} className="h-10 text-sm w-full" placeholder="Začátek" />
                <TimePicker value={endTimeDraft} onChange={setEndTimeDraft} className="h-10 text-sm w-full" placeholder="Konec" />
              </div>
            ) : (
              <>
                <p className="font-medium">{format(new Date(job.date), "d.M.yyyy")}</p>
                {(job.startTime || job.endTime) && (
                  <p className="text-muted-foreground">{job.startTime || '?'} – {job.endTime || '?'}</p>
                )}
              </>
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
                    {job.customerId ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/customers/${job.customerId}`)}
                        className="text-primary font-medium hover:underline text-left"
                      >
                        {job.customerCompanyName}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">{job.customerCompanyName}</span>
                    )}
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

        {/* Address / Waze navigation */}
        <div className="col-span-2 pt-2">
          <div className="flex items-center justify-between mb-1">
            <p className="text-muted-foreground flex items-center gap-1 text-sm"><Navigation className="w-3.5 h-3.5 text-blue-500" /> Adresa (navigace)</p>
            {!editingAddress && (
              <Button variant="ghost" size="sm" onClick={() => setEditingAddress(true)} className="h-7 text-xs">
                <Edit3 className="w-3 h-3 mr-1" /> Upravit
              </Button>
            )}
          </div>
          {editingAddress ? (
            <div className="space-y-2">
              <Input
                value={addressDraft}
                onChange={e => setAddressDraft(e.target.value)}
                placeholder="Korunní 47, Praha 2"
                className="h-10 text-sm"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveAddress} disabled={updateJob.isPending} className="h-8 px-3 text-xs">
                  <Save className="w-3 h-3 mr-1" /> Uložit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingAddress(false); setAddressDraft(job.address || ""); }} className="h-8 px-2 text-xs">
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ) : job.address ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{job.address}</span>
              <a
                href={`https://waze.com/ul?q=${encodeURIComponent(job.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-blue-500 hover:underline font-medium ml-1"
              >
                <Navigation className="w-3.5 h-3.5" /> Waze
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Nezadána</p>
          )}
        </div>

        <div className="pt-4 border-t col-span-2">
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

  const { uploadFile: uploadPhotoForTask } = useUpload();

  const handleTaskPhoto = async (taskId: number, file: File) => {
    try {
      const prepared = await prepareImageFile(file);
      const result = await uploadPhotoForTask(prepared);
      createAttachment.mutate({ jobId, data: { type: "photo", fileName: prepared.name, url: result.objectPath, description: `Foto k úkolu` } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) });
          toast({ title: "Fotografie uložena" });
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Neznámá chyba";
      debugLog("upload", "task photo upload failed", err);
      toast({ title: "Nahrání fotky selhalo", description: msg, variant: "destructive" });
    }
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

function JobTimeEntries({ jobId }: { jobId: number }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const listKey = getListJobTimeEntriesQueryKey(jobId);
  const { data: entries } = useListJobTimeEntries(jobId, {
    query: { queryKey: listKey, enabled: Number.isFinite(jobId) },
  });
  const { data: people } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const addPerson = useCreateJobTimeEntry();
  const startTimer = useStartJobTimeEntry();
  const stopTimer = useStopJobTimeEntry();
  const setHours = useUpdateJobTimeEntry();
  const removeEntry = useDeleteJobTimeEntry();

  const invalidate = () => {
    invalidateData(queryClient, "jobs");
  };

  const busy = addPerson.isPending || startTimer.isPending || stopTimer.isPending || setHours.isPending || removeEntry.isPending;

  return (
    <TimeEntriesSection
      entries={entries ?? []}
      people={people ?? []}
      canWrite={can("write")}
      busy={busy}
      onAddPerson={(personId) => addPerson.mutate({ jobId, data: { personId } }, { onSuccess: invalidate })}
      onStart={(personId) => startTimer.mutate({ jobId, personId }, { onSuccess: invalidate })}
      onStop={(personId) => stopTimer.mutate({ jobId, personId }, { onSuccess: invalidate })}
      onSetHours={(personId, hours) => setHours.mutate({ jobId, personId, data: { hours } }, { onSuccess: invalidate })}
      onRemove={(personId) => removeEntry.mutate({ jobId, personId }, { onSuccess: invalidate })}
    />
  );
}

const PRICE_SOURCE_META: Record<string, { label: string; cls: string }> = {
  invoice: { label: "Z faktury", cls: "bg-emerald-100 text-emerald-700" },
  delivery_note: { label: "Z dodacího listu", cls: "bg-blue-100 text-blue-700" },
  awaiting_invoice: { label: "Čeká na fakturu", cls: "bg-amber-100 text-amber-700" },
  stock_history: { label: "Ze skladové historie", cls: "bg-cyan-100 text-cyan-700" },
  manual: { label: "Ručně", cls: "bg-muted text-muted-foreground" },
};

function MaterialsSection({ jobId, isExpanded, onToggle }: any) {
  const { data: materials } = useListMaterials(jobId, {
    query: { enabled: isExpanded, queryKey: getListMaterialsQueryKey(jobId) }
  });
  const createMaterial = useCreateMaterial();
  const updateMaterial = useUpdateMaterial();
  const deleteMaterial = useDeleteMaterial();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: warehouseItems } = useListWarehouseItems({
    query: { enabled: isExpanded, queryKey: getListWarehouseItemsQueryKey() }
  });
  const materialSuggestions = (warehouseItems ?? []).map((w: any) => w.name);
  const stockNames = new Set(
    (warehouseItems ?? []).map((w: any) => String(w.name).trim().toLowerCase()),
  );

  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newUnit, setNewUnit] = useState("ks");
  const [newPrice, setNewPrice] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});

  const totalCost = materials?.reduce((sum: number, m: any) => sum + (m.pricePerUnit && m.quantity ? m.pricePerUnit * m.quantity : 0), 0) || 0;
  const summary = materials?.length ? `${materials.length} položek${totalCost > 0 ? ` • ${totalCost.toLocaleString("cs-CZ")} Kč` : ""}` : "Žádný materiál";

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createMaterial.mutate({ jobId, data: { name: newName.trim(), quantity: newQty ? parseFloat(newQty) : null, unit: newUnit || null, pricePerUnit: newPrice ? parseFloat(newPrice) : null } }, {
      onSuccess: () => {
        setNewName(""); setNewQty(""); setNewUnit("ks"); setNewPrice("");
        invalidateData(queryClient, "jobs", "warehouse");
      }
    });
  };

  const handleDelete = (materialId: number) => {
    if (!confirm("Smazat materiál?")) return;
    deleteMaterial.mutate({ jobId, materialId }, {
      onSuccess: () => {
        invalidateData(queryClient, "jobs", "warehouse");
        toast({ title: "Materiál odstraněn" });
      }
    });
  };

  const startEdit = (m: any) => { setEditingId(m.id); setEditDraft({ name: m.name, quantity: m.quantity ?? "", unit: m.unit ?? "ks", pricePerUnit: m.pricePerUnit ?? "" }); };
  const cancelEdit = () => { setEditingId(null); setEditDraft({}); };
  const saveEdit = () => {
    if (!editDraft.name?.trim()) return;
    updateMaterial.mutate({ jobId, materialId: editingId!, data: { name: editDraft.name.trim(), quantity: editDraft.quantity !== "" ? parseFloat(editDraft.quantity) : null, unit: editDraft.unit || null, pricePerUnit: editDraft.pricePerUnit !== "" ? parseFloat(editDraft.pricePerUnit) : null } }, {
      onSuccess: () => { invalidateData(queryClient, "jobs", "warehouse"); cancelEdit(); }
    });
  };

  return (
    <SectionCard title="Materiál" icon={ShoppingCart} isExpanded={isExpanded} onToggle={onToggle} summary={summary}>
      <div className="p-4 space-y-4">
        {/* Add form */}
        <form onSubmit={handleAdd} className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <Autocomplete value={newName} onValueChange={setNewName} suggestions={materialSuggestions} placeholder="Název materiálu..." className="h-12 text-base bg-background" />
            </div>
            <Button type="submit" disabled={!newName.trim() || createMaterial.isPending} className="h-12 px-4">
              <Plus className="w-5 h-5" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Input value={newQty} onChange={e => setNewQty(e.target.value)} placeholder="Množství" type="number" min="0" step="any" className="h-10 text-sm w-24 bg-background" />
            <Input value={newUnit} onChange={e => setNewUnit(e.target.value)} placeholder="Jednotka" className="h-10 text-sm w-20 bg-background" />
            <Input value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="Cena/ks (Kč)" type="number" min="0" step="any" className="h-10 text-sm flex-1 bg-background" />
          </div>
        </form>

        {/* Materials list */}
        {materials && materials.length > 0 ? (
          <div className="space-y-1.5">
            {materials.map((m: any) => (
              editingId === m.id ? (
                <div key={m.id} className="p-3 border rounded-lg space-y-2 bg-card">
                  <Input value={editDraft.name} onChange={e => setEditDraft((d: any) => ({ ...d, name: e.target.value }))} className="h-9 text-sm" autoFocus />
                  <div className="flex gap-2">
                    <Input value={editDraft.quantity} onChange={e => setEditDraft((d: any) => ({ ...d, quantity: e.target.value }))} placeholder="Množ." type="number" className="h-9 text-sm w-24" />
                    <Input value={editDraft.unit} onChange={e => setEditDraft((d: any) => ({ ...d, unit: e.target.value }))} placeholder="Jedn." className="h-9 text-sm w-20" />
                    <Input value={editDraft.pricePerUnit} onChange={e => setEditDraft((d: any) => ({ ...d, pricePerUnit: e.target.value }))} placeholder="Cena/ks" type="number" className="h-9 text-sm flex-1" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit} disabled={updateMaterial.isPending} className="h-8 text-xs px-3"><Save className="w-3.5 h-3.5 mr-1" /> Uložit</Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-8 text-xs px-2"><X className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex items-center gap-2 p-3 bg-card border rounded-lg hover:bg-muted/50 transition-colors">
                  <ShoppingCart className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{m.name}</span>
                    {m.sourceType && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 align-middle">Z dokladu</span>
                    )}
                    {m.priceSource && PRICE_SOURCE_META[m.priceSource] && (
                      <span className={`ml-2 inline-flex items-center rounded-full text-[10px] font-medium px-1.5 py-0.5 align-middle ${PRICE_SOURCE_META[m.priceSource].cls}`}>{PRICE_SOURCE_META[m.priceSource].label}</span>
                    )}
                    {m.invoicedInvoiceId != null && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 text-violet-700 text-[10px] font-medium px-1.5 py-0.5 align-middle">Vyfakturováno</span>
                    )}
                    {m.name && stockNames.has(String(m.name).trim().toLowerCase()) && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-cyan-100 text-cyan-700 text-[10px] font-medium px-1.5 py-0.5 align-middle">Sklad −</span>
                    )}
                    {(m.quantity != null || m.unit) && (
                      <span className="text-muted-foreground text-xs ml-2">{m.quantity} {m.unit}</span>
                    )}
                    {(m.priceSourceSupplierName || m.priceConfidence != null || m.adminNote) && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {m.priceSourceSupplierName && <span>{m.priceSourceSupplierName}</span>}
                        {m.priceConfidence != null && <span>{m.priceSourceSupplierName ? " • " : ""}spolehlivost {Math.round(m.priceConfidence * 100)} %</span>}
                        {m.adminNote && <span>{(m.priceSourceSupplierName || m.priceConfidence != null) ? " • " : ""}{m.adminNote}</span>}
                      </div>
                    )}
                  </div>
                  {m.pricePerUnit != null && (
                    <span className="text-sm font-semibold text-emerald-600 shrink-0">
                      {m.quantity ? `${(m.pricePerUnit * m.quantity).toLocaleString("cs-CZ")} Kč` : `${m.pricePerUnit} Kč/ks`}
                    </span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => startEdit(m)} className="h-8 w-8 p-0 shrink-0">
                    <Edit3 className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(m.id)} className="h-8 w-8 p-0 text-destructive shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )
            ))}
            {totalCost > 0 && (
              <div className="flex justify-between items-center pt-2 px-1 text-sm font-bold border-t mt-2">
                <span>Celkem materiál</span>
                <span className="text-emerald-600">{totalCost.toLocaleString("cs-CZ")} Kč</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6 text-muted-foreground text-sm">Žádný materiál zatím.</div>
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
    query: { queryKey: getListAttachmentsQueryKey(jobId) }
  });
  
  const createAttachment = useCreateAttachment();
  const deleteAttachment = useDeleteAttachment();
  const analyzeDocuments = useAnalyzeJobDocuments();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const doklady = attachments?.filter(a => ["invoice", "receipt", "delivery_note", "credit_note"].includes(a.type)) || [];
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);
  // Document type to assign to uploads; "auto" infers from file kind (photo→receipt, PDF→invoice).
  const [dokladType, setDokladType] = useState<string>("auto");

  const handleAnalyze = () => {
    analyzeDocuments.mutate({ id: jobId }, {
      onSuccess: (res) => {
        const created = res?.createdCount ?? 0;
        const skipped = res?.skipped ?? 0;
        toast({
          title: created > 0
            ? `Zařazeno ke zpracování: ${created}`
            : "Žádné nové doklady k analýze",
          description: skipped > 0
            ? `Přeskočeno ${skipped} již zpracovaných. Doklady najdete ve Fakturace → Přijaté doklady.`
            : "Doklady najdete ve Fakturace → Přijaté doklady.",
        });
      },
      onError: (err) => toast({
        title: "Analýza se nezdařila",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
    });
  };

  const {
    uploadFile: uploadDoklad,
    uploadFiles: uploadDoklady,
    isBusy: isUploadingDoklad,
    displayProgress: dokladProgress,
    statusLabel: dokladStatus,
  } = useUpload();

  const uploadDokladyFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const { succeeded, failed, errors } = await uploadDoklady(files, async (file) => {
      const isPhoto = file.type.startsWith("image/") ||
        file.name.toLowerCase().endsWith(".heic") || file.name.toLowerCase().endsWith(".heif");
      const type = dokladType === "auto" ? (isPhoto ? "receipt" : "invoice") : dokladType;
      const toUpload = isPhoto ? await prepareImageFile(file) : file;
      const result = await uploadDoklad(toUpload);
      await createAttachment.mutateAsync({ jobId, data: { type, fileName: toUpload.name, url: result.objectPath } });
    });

    queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) });
    if (succeeded > 0) {
      toast({ title: succeeded === 1 ? "Doklad uložen" : `Nahráno ${succeeded} dokladů` });
    }
    if (failed > 0) {
      debugLog("upload", "doklad upload failed", errors);
      const description = files.length === 1
        ? (errors[0]?.message ?? "Neznámá chyba")
        : `${failed} z ${files.length} se nepodařilo nahrát`;
      toast({ title: "Nahrání selhalo", description, variant: "destructive" });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadDokladyFiles(files);
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
          multiple
          ref={fileInputRef} 
          onChange={handleFileUpload} 
          className="hidden" 
        />
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Typ dokladu</Label>
          <Select value={dokladType} onValueChange={setDokladType}>
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automaticky (foto → účtenka, PDF → faktura)</SelectItem>
              <SelectItem value="invoice">{COST_DOC_TYPE_LABELS.invoice}</SelectItem>
              <SelectItem value="receipt">{COST_DOC_TYPE_LABELS.receipt}</SelectItem>
              <SelectItem value="delivery_note">{COST_DOC_TYPE_LABELS.delivery_note}</SelectItem>
              <SelectItem value="credit_note">{COST_DOC_TYPE_LABELS.credit_note}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={() => fileInputRef.current?.click()} 
            disabled={createAttachment.isPending || isUploadingDoklad}
            variant="secondary"
            className="flex-1 h-12 text-base"
          >
            <Camera className="w-5 h-5 mr-2" /> {isUploadingDoklad ? dokladStatus : "Vyfotit / nahrát doklad"}
          </Button>
        </div>
        <FileDropZone
          onFiles={uploadDokladyFiles}
          accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png"
          disabled={createAttachment.isPending || isUploadingDoklad}
          label="Sem přetáhněte doklady (PDF nebo foto)"
        />
        <UploadProgressBar isUploading={isUploadingDoklad} progress={dokladProgress} />

        {doklady.length > 0 && (
          <Button
            onClick={handleAnalyze}
            disabled={analyzeDocuments.isPending}
            variant="outline"
            className="w-full"
          >
            <FileText className="w-4 h-4 mr-2" />
            {analyzeDocuments.isPending ? "Analyzuji…" : "Analyzovat doklady"}
          </Button>
        )}

        {doklady.length > 0 && (
          <div className="space-y-2">
            {doklady.map(doc => {
              const displayUrl = getAttachmentUrl(doc.url);
              return (
                <div key={doc.id} className="flex items-center gap-3 p-3 bg-muted/40 border rounded-lg group">
                  <div className="p-1.5 bg-amber-100 dark:bg-amber-900/30 rounded text-amber-600 dark:text-amber-400 shrink-0">
                    <FileImage className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.fileName || "Doklad"}</p>
                    <p className="text-xs text-muted-foreground capitalize">{doc.type === "invoice" ? "Faktura" : doc.type === "receipt" ? "Účtenka" : "Dodací list"}</p>
                  </div>
                  {displayUrl && (
                    <button onClick={() => setViewer({ url: displayUrl, fileName: doc.fileName })} className="text-xs text-primary hover:underline shrink-0">Zobrazit</button>
                  )}
                  <Button 
                    variant="ghost" size="icon" 
                    className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    onClick={() => handleDelete(doc.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {doklady.length === 0 && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Receipt className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Přidejte faktury, účtenky nebo dodací listy.</p>
          </div>
        )}
        {viewer && <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />}
      </div>
    </SectionCard>
  );
}

function JobSheetsSection({ jobId, isExpanded, onToggle }: any) {
  const { data: attachments } = useListAttachments(jobId, {
    query: { queryKey: getListAttachmentsQueryKey(jobId) }
  });
  const deleteAttachment = useDeleteAttachment();
  const queryClient = useQueryClient();

  const sheets = (attachments?.filter(a => a.type === "job_sheet") || [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);

  const handleDelete = (id: number) => {
    if (!confirm("Smazat tento zakázkový list?")) return;
    deleteAttachment.mutate({ jobId, attachmentId: id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })
    });
  };

  return (
    <SectionCard
      title="Zakázkové listy"
      icon={FileText}
      isExpanded={isExpanded}
      onToggle={onToggle}
      summary={sheets.length > 0 ? `${sheets.length} uložených` : "Žádné uložené"}
    >
      <div className="p-4 space-y-2">
        {sheets.length === 0 && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Podepsané zakázkové listy se uloží sem.</p>
          </div>
        )}
        {sheets.map(sheet => {
          const displayUrl = getAttachmentUrl(sheet.url);
          return (
            <div key={sheet.id} className="flex items-center gap-3 p-3 bg-muted/40 border rounded-lg group">
              <div className="p-1.5 bg-primary/10 rounded text-primary shrink-0">
                <FileText className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{sheet.description || "Zakázkový list"}</p>
                <p className="text-xs text-muted-foreground">{format(new Date(sheet.createdAt), "d.M.yyyy H:mm")}</p>
              </div>
              {displayUrl && (
                <button onClick={() => setViewer({ url: displayUrl, fileName: sheet.description || sheet.fileName || "Zakázkový list.pdf" })} className="text-xs text-primary hover:underline shrink-0">Otevřít</button>
              )}
              <Button
                variant="ghost" size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => handleDelete(sheet.id)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          );
        })}
        {viewer && <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />}
      </div>
    </SectionCard>
  );
}

function AttachmentsSection({ jobId, isExpanded, onToggle }: any) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { data: attachments } = useListAttachments(jobId, {
    query: { queryKey: getListAttachmentsQueryKey(jobId) }
  });
  
  const createAttachment = useCreateAttachment();
  const deleteAttachment = useDeleteAttachment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    uploadFile: uploadPhoto,
    uploadFiles: uploadPhotos,
    isBusy: isUploadingPhoto,
    displayProgress: photoProgress,
    statusLabel: photoStatus,
  } = useUpload();

  const uploadPhotoFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const { succeeded, failed, errors } = await uploadPhotos(files, async (file) => {
      const prepared = await prepareImageFile(file);
      const result = await uploadPhoto(prepared);
      await createAttachment.mutateAsync({
        jobId,
        data: { type: "photo", fileName: prepared.name, url: result.objectPath, description: "Foto ze stavby" }
      });
    });

    queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) });
    if (succeeded > 0) {
      toast({ title: succeeded === 1 ? "Fotografie uložena" : `Nahráno ${succeeded} fotek` });
    }
    if (failed > 0) {
      debugLog("upload", "photo upload failed", errors);
      const description = files.length === 1
        ? (errors[0]?.message ?? "Neznámá chyba")
        : `${failed} z ${files.length} se nepodařilo nahrát`;
      toast({ title: "Nahrání fotky selhalo", description, variant: "destructive" });
    }
  };

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadPhotoFiles(files);
  };

  const handleDelete = (attachmentId: number) => {
    if (!confirm("Smazat tuto fotografii?")) return;
    deleteAttachment.mutate({ jobId, attachmentId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })
    });
  };

  const photos = attachments?.filter(a => a.type === "photo") || [];
  const [viewer, setViewer] = useState<{ url: string; fileName?: string | null } | null>(null);
  
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
            ref={cameraInputRef} onChange={handlePhotoCapture} className="hidden"
          />
          <input 
            type="file" accept="image/*" multiple
            ref={fileInputRef} onChange={handlePhotoCapture} className="hidden" 
          />
          <Button 
            onClick={() => cameraInputRef.current?.click()} 
            disabled={createAttachment.isPending || isUploadingPhoto}
            className="flex-1 h-14 bg-primary text-primary-foreground text-base"
          >
            <Camera className="w-5 h-5 mr-2" /> {isUploadingPhoto ? photoStatus : "Vyfotit"}
          </Button>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={createAttachment.isPending || isUploadingPhoto}
            className="flex-1 h-14 text-base"
          >
            <FileImage className="w-5 h-5 mr-2" /> Z galerie
          </Button>
        </div>
        <FileDropZone
          onFiles={uploadPhotoFiles}
          accept="image/*"
          disabled={createAttachment.isPending || isUploadingPhoto}
          label="Sem přetáhněte fotky"
        />
        <UploadProgressBar isUploading={isUploadingPhoto} progress={photoProgress} />

        {photos.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {photos.map(photo => {
              const src = getAttachmentUrl(photo.url);
              return (
                <div key={photo.id} className="relative aspect-square rounded-xl overflow-hidden border group bg-muted">
                  {src ? (
                    <button type="button" onClick={() => setViewer({ url: src, fileName: photo.fileName })} className="w-full h-full">
                      <img src={src} alt={photo.fileName || "Fotografie"} className="w-full h-full object-cover" />
                    </button>
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
              );
            })}
          </div>
        )}
        
        {photos.length === 0 && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Camera className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p>Foťte průběh prací, stav stavby apod.</p>
          </div>
        )}
        {viewer && <AttachmentViewer url={viewer.url} fileName={viewer.fileName} onClose={() => setViewer(null)} />}
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
        hoursFromPlan: false,
        hoursBeforePlan: null,
        price: price ? parseFloat(price) : null
      } 
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        invalidateJobLists(queryClient);
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
        invalidateJobLists(queryClient);
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
