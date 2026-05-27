import { useState, useRef } from "react";
import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { 
  useGetJob, getGetJobQueryKey, 
  useUpdateJobStatus, useUpdateJob,
  useListTasks, getListTasksQueryKey, useCreateTask, useUpdateTask, useDeleteTask,
  useListAttachments, getListAttachmentsQueryKey, useCreateAttachment, useDeleteAttachment 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  ArrowLeft, Clock, MapPin, User, FileText, CheckCircle2, ChevronDown, 
  ChevronUp, Camera, Plus, Trash2, Edit3, Save, X, Paperclip, CreditCard,
  AlertCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { JOB_STATUSES, JOB_TYPES, StatusBadge, TypeBadge } from "@/components/badges";

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
    return <div className="p-8 text-center">Job not found</div>;
  }

  const handleStatusChange = (newStatus: string) => {
    updateStatus.mutate({ id, data: { status: newStatus } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(id), data);
        toast({ title: "Status updated" });
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
              {format(new Date(job.date), "MMM d")}
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
        {/* Sections */}
        <InfoSection job={job} isExpanded={expandedSection === "info"} onToggle={() => toggleSection("info")} />
        <TasksSection jobId={id} isExpanded={expandedSection === "tasks"} onToggle={() => toggleSection("tasks")} />
        <AttachmentsSection jobId={id} isExpanded={expandedSection === "attachments"} onToggle={() => toggleSection("attachments")} />
        <WorkSummarySection job={job} isExpanded={expandedSection === "summary"} onToggle={() => toggleSection("summary")} />
        <CostsSection job={job} isExpanded={expandedSection === "costs"} onToggle={() => toggleSection("costs")} />
      </div>
    </div>
  );
}

// Subcomponents

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
          <div className="absolute right-0 mt-2 w-48 bg-card border rounded-lg shadow-xl z-40 overflow-hidden">
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
  
  const [isEditing, setIsEditing] = useState(false);
  const [notes, setNotes] = useState(job.notes || "");

  const saveNotes = () => {
    updateJob.mutate({ id: job.id, data: { notes } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        setIsEditing(false);
        toast({ title: "Notes updated" });
      }
    });
  };

  return (
    <SectionCard 
      title="Job Details" 
      icon={FileText} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={job.notes ? "Has notes" : "No notes"}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-y-4 gap-x-2 text-sm">
          <div>
            <p className="text-muted-foreground mb-1 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Date & Time</p>
            <p className="font-medium">{format(new Date(job.date), "MMM d, yyyy")}</p>
            {(job.startTime || job.endTime) && (
              <p className="text-muted-foreground">{job.startTime || '?'} - {job.endTime || '?'}</p>
            )}
          </div>
          <div>
            <p className="text-muted-foreground mb-1 flex items-center gap-1"><User className="w-3.5 h-3.5" /> Assigned To</p>
            <p className="font-medium">{job.assignedPersonName || "Unassigned"}</p>
          </div>
          <div className="col-span-2">
            <p className="text-muted-foreground mb-1 flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Client / Site</p>
            <p className="font-medium">{job.clientSite || "Not specified"}</p>
          </div>
        </div>

        <div className="pt-4 border-t">
          <div className="flex justify-between items-center mb-2">
            <p className="font-bold">Notes</p>
            {!isEditing ? (
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-8">
                <Edit3 className="w-4 h-4 mr-2" /> Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setNotes(job.notes || ""); }} className="h-8">
                  <X className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={saveNotes} disabled={updateJob.isPending} className="h-8">
                  <Save className="w-4 h-4 mr-2" /> Save
                </Button>
              </div>
            )}
          </div>
          
          {isEditing ? (
            <Textarea 
              value={notes} 
              onChange={e => setNotes(e.target.value)} 
              className="min-h-[100px] text-base"
              placeholder="Add notes..."
              autoFocus
            />
          ) : (
            <div className="bg-muted/30 p-3 rounded-lg min-h-[80px] text-sm whitespace-pre-wrap">
              {job.notes || <span className="text-muted-foreground italic">No notes added.</span>}
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
  const queryClient = useQueryClient();
  
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
    if (!confirm("Delete this task?")) return;
    deleteTask.mutate({ jobId, taskId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })
    });
  };

  const regularTasks = tasks?.filter(t => !t.isChangeRequest) || [];
  const changeRequests = tasks?.filter(t => t.isChangeRequest) || [];

  const doneCount = tasks?.filter(t => t.done).length || 0;
  const totalCount = tasks?.length || 0;
  const summary = totalCount > 0 ? `${doneCount}/${totalCount} completed` : "No tasks";

  return (
    <SectionCard 
      title="Tasks & Checklist" 
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
              placeholder="Add a new task..." 
              className="h-12 text-base flex-1 bg-background"
            />
            <Button type="submit" disabled={!newTaskTitle.trim() || createTask.isPending} className="h-12 px-6">
              <Plus className="w-5 h-5" />
            </Button>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox id="isChange" checked={isChange} onCheckedChange={(c) => setIsChange(!!c)} className="w-5 h-5" />
            <label htmlFor="isChange" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center">
              Mark as extra work / change request <AlertCircle className="w-3.5 h-3.5 ml-1.5 text-indigo-500" />
            </label>
          </div>
        </form>

        {regularTasks.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Tasks</h4>
            <div className="space-y-1">
              {regularTasks.map(task => (
                <TaskRow key={task.id} task={task} onToggle={handleToggleTask} onDelete={handleDeleteTask} />
              ))}
            </div>
          </div>
        )}

        {changeRequests.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-indigo-600 uppercase tracking-wider flex items-center">
              <AlertCircle className="w-4 h-4 mr-1" /> Change Requests
            </h4>
            <div className="space-y-1 bg-indigo-50/50 dark:bg-indigo-950/20 p-2 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
              {changeRequests.map(task => (
                <TaskRow key={task.id} task={task} onToggle={handleToggleTask} onDelete={handleDeleteTask} />
              ))}
            </div>
          </div>
        )}
        
        {totalCount === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            No tasks added yet.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function TaskRow({ task, onToggle, onDelete }: any) {
  return (
    <div className="flex items-start gap-3 p-3 bg-card border rounded-lg hover:bg-muted/50 transition-colors group">
      <Checkbox 
        checked={task.done} 
        onCheckedChange={(c) => onToggle(task.id, !!c)} 
        className="mt-0.5 w-6 h-6 rounded-full border-2 data-[state=checked]:bg-green-500 data-[state=checked]:border-green-500"
      />
      <div className={`flex-1 text-base ${task.done ? 'line-through text-muted-foreground' : 'font-medium'}`}>
        {task.title}
      </div>
      <Button 
        variant="ghost" 
        size="icon" 
        onClick={() => onDelete(task.id)} 
        className="opacity-0 group-hover:opacity-100 h-8 w-8 text-muted-foreground hover:text-destructive shrink-0 transition-opacity"
      >
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
}

function WorkSummarySection({ job, isExpanded, onToggle }: any) {
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [hours, setHours] = useState(job.hoursSpent?.toString() || "");
  const [price, setPrice] = useState(job.price?.toString() || "");

  const handleSave = () => {
    updateJob.mutate({ 
      id: job.id, 
      data: { 
        hoursSpent: hours ? parseFloat(hours) : null,
        price: price ? parseFloat(price) : null
      } 
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        toast({ title: "Work summary saved" });
      }
    });
  };

  const summary = (job.hoursSpent || job.price) 
    ? `${job.hoursSpent || 0}h logged • $${job.price || 0}`
    : "Not logged";

  return (
    <SectionCard 
      title="Work Summary" 
      icon={Clock} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={summary}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Hours Spent</label>
            <div className="relative">
              <Input 
                type="number" 
                step="0.5" 
                value={hours} 
                onChange={e => setHours(e.target.value)} 
                className="h-14 text-lg pl-4 pr-10" 
                placeholder="0.0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">h</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Price</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
              <Input 
                type="number" 
                step="0.01" 
                value={price} 
                onChange={e => setPrice(e.target.value)} 
                className="h-14 text-lg pl-8" 
                placeholder="0.00"
              />
            </div>
          </div>
        </div>
        <Button onClick={handleSave} disabled={updateJob.isPending} className="w-full h-12">
          <Save className="w-5 h-5 mr-2" /> Save Summary
        </Button>
      </div>
    </SectionCard>
  );
}

function CostsSection({ job, isExpanded, onToggle }: any) {
  const updateJob = useUpdateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [costs, setCosts] = useState({
    transportKm: job.transportKm?.toString() || "",
    transportCost: job.transportCost?.toString() || "",
    fines: job.fines?.toString() || "",
    parking: job.parking?.toString() || ""
  });

  const handleSave = () => {
    const data = {
      transportKm: costs.transportKm ? parseFloat(costs.transportKm) : null,
      transportCost: costs.transportCost ? parseFloat(costs.transportCost) : null,
      fines: costs.fines ? parseFloat(costs.fines) : null,
      parking: costs.parking ? parseFloat(costs.parking) : null,
    };
    
    updateJob.mutate({ id: job.id, data }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetJobQueryKey(job.id), data);
        toast({ title: "Costs saved" });
      }
    });
  };

  const hasCosts = job.transportKm || job.transportCost || job.fines || job.parking;

  return (
    <SectionCard 
      title="Travel & Expenses" 
      icon={CreditCard} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={hasCosts ? "Expenses logged" : "None"}
    >
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Transport Distance</label>
            <div className="relative">
              <Input 
                type="number" 
                value={costs.transportKm} 
                onChange={e => setCosts(prev => ({...prev, transportKm: e.target.value}))} 
                className="h-14 text-base pr-10" 
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">km</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Transport Cost</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input 
                type="number" 
                value={costs.transportCost} 
                onChange={e => setCosts(prev => ({...prev, transportCost: e.target.value}))} 
                className="h-14 text-base pl-7" 
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Parking</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input 
                type="number" 
                value={costs.parking} 
                onChange={e => setCosts(prev => ({...prev, parking: e.target.value}))} 
                className="h-14 text-base pl-7" 
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-muted-foreground">Fines</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input 
                type="number" 
                value={costs.fines} 
                onChange={e => setCosts(prev => ({...prev, fines: e.target.value}))} 
                className="h-14 text-base pl-7" 
              />
            </div>
          </div>
        </div>
        <Button onClick={handleSave} disabled={updateJob.isPending} className="w-full h-12" variant="secondary">
          <Save className="w-5 h-5 mr-2" /> Save Expenses
        </Button>
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
        data: { 
          type: "photo", 
          fileName: file.name,
          url: base64Url,
          description: "Site photo" 
        } 
      }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) });
          toast({ title: "Photo saved" });
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = (attachmentId: number) => {
    if (!confirm("Delete this attachment?")) return;
    deleteAttachment.mutate({ jobId, attachmentId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })
    });
  };

  const photos = attachments?.filter(a => a.type === "photo") || [];
  
  return (
    <SectionCard 
      title="Photos & Attachments" 
      icon={Camera} 
      isExpanded={isExpanded} 
      onToggle={onToggle}
      summary={attachments?.length ? `${attachments.length} items` : "No photos"}
    >
      <div className="p-4 space-y-6">
        <div className="flex gap-3">
          <input 
            type="file" 
            accept="image/*" 
            capture="environment" 
            ref={fileInputRef} 
            onChange={handlePhotoCapture} 
            className="hidden" 
          />
          <Button 
            onClick={() => fileInputRef.current?.click()} 
            disabled={createAttachment.isPending}
            className="flex-1 h-14 bg-primary text-primary-foreground text-base"
          >
            <Camera className="w-5 h-5 mr-2" /> Take Photo
          </Button>
        </div>

        {photos.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {photos.map(photo => (
              <div key={photo.id} className="relative aspect-square rounded-xl overflow-hidden border group bg-muted">
                {photo.url ? (
                  <img src={photo.url} alt={photo.fileName || "Photo"} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                    <Camera className="w-8 h-8 opacity-20" />
                  </div>
                )}
                <button 
                  onClick={() => handleDelete(photo.id)}
                  className="absolute top-2 right-2 p-1.5 bg-background/80 backdrop-blur-sm rounded-full text-destructive shadow-sm"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        
        {(!attachments || attachments.length === 0) && (
          <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <Camera className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p>Take photos of the site, receipts, or documents.</p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
