import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { format } from "date-fns";
import { useCreateJob, useListPeople, getListPeopleQueryKey, getListJobsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_TYPES, JOB_STATUSES } from "@/components/badges";
import { ArrowLeft, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function JobForm() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const queryParams = new URLSearchParams(search);
  const initialDate = queryParams.get("date") || format(new Date(), "yyyy-MM-dd");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createJob = useCreateJob();
  
  const { data: people } = useListPeople({
    query: { queryKey: getListPeopleQueryKey() }
  });

  const [formData, setFormData] = useState({
    title: "",
    type: "planned_work",
    clientSite: "",
    date: initialDate,
    startTime: "",
    endTime: "",
    assignedPersonId: "none",
    status: "planned",
    notes: ""
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (name: string, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
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
      notes: formData.notes || null,
    };

    createJob.mutate({ data: jobData }, {
      onSuccess: (newJob) => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        toast({ title: "Job created" });
        setLocation(`/jobs/${newJob.id}`);
      },
      onError: () => {
        toast({ title: "Failed to create job", variant: "destructive" });
      }
    });
  };

  return (
    <div className="flex flex-col min-h-screen bg-background pb-20 md:pb-0">
      <div className="sticky top-0 z-10 bg-card border-b p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()}>
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <h1 className="text-xl font-bold flex-1">New Job</h1>
        <Button onClick={handleSubmit} disabled={createJob.isPending} className="h-10 px-4">
          <Save className="h-5 w-5 mr-2" /> Save
        </Button>
      </div>

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full flex-1">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="title" className="text-base">Job Title *</Label>
            <Input 
              id="title" 
              name="title" 
              value={formData.title} 
              onChange={handleChange} 
              placeholder="e.g. Roof inspection" 
              className="h-14 text-lg"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label className="text-base">Job Type</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(JOB_TYPES).map(([key, config]) => {
                const isSelected = formData.type === key;
                const Icon = config.icon;
                return (
                  <div 
                    key={key}
                    onClick={() => handleSelectChange("type", key)}
                    className={`flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                      isSelected 
                        ? 'border-primary bg-primary/10' 
                        : 'border-border bg-card hover:bg-muted'
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

          <div className="space-y-2">
            <Label htmlFor="clientSite" className="text-base">Client / Site</Label>
            <Input 
              id="clientSite" 
              name="clientSite" 
              value={formData.clientSite} 
              onChange={handleChange} 
              placeholder="e.g. 123 Main St" 
              className="h-14 text-base"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date" className="text-base">Date *</Label>
              <Input 
                id="date" 
                name="date" 
                type="date" 
                value={formData.date} 
                onChange={handleChange} 
                className="h-14 text-base block w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="startTime" className="text-base">Start Time</Label>
              <Input 
                id="startTime" 
                name="startTime" 
                type="time" 
                value={formData.startTime} 
                onChange={handleChange} 
                className="h-14 text-base block w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endTime" className="text-base">End Time</Label>
              <Input 
                id="endTime" 
                name="endTime" 
                type="time" 
                value={formData.endTime} 
                onChange={handleChange} 
                className="h-14 text-base block w-full"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-base">Assigned To</Label>
              <Select value={formData.assignedPersonId} onValueChange={(v) => handleSelectChange("assignedPersonId", v)}>
                <SelectTrigger className="h-14 text-base">
                  <SelectValue placeholder="Select worker" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {people?.map(p => (
                    <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-base">Status</Label>
              <Select value={formData.status} onValueChange={(v) => handleSelectChange("status", v)}>
                <SelectTrigger className="h-14 text-base">
                  <SelectValue placeholder="Select status" />
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
            <Label htmlFor="notes" className="text-base">Notes</Label>
            <Textarea 
              id="notes" 
              name="notes" 
              value={formData.notes} 
              onChange={handleChange} 
              placeholder="Any additional details..." 
              className="min-h-[120px] text-base resize-y"
            />
          </div>
          
          {/* Bottom padding so content isn't hidden behind save button on mobile */}
          <div className="h-12 md:hidden"></div>
        </form>
      </div>
      
      <div className="md:hidden fixed bottom-16 left-0 right-0 p-4 bg-background border-t">
        <Button onClick={handleSubmit} disabled={createJob.isPending} className="w-full h-14 text-lg font-bold">
          <Save className="h-6 w-6 mr-2" /> Save Job
        </Button>
      </div>
    </div>
  );
}
