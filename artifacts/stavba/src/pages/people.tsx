import { useState } from "react";
import { useListPeople, useCreatePerson, useDeletePerson, getListPeopleQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Trash2, Plus, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function People() {
  const [newPersonName, setNewPersonName] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: people, isLoading } = useListPeople({
    query: { queryKey: getListPeopleQueryKey() }
  });

  const createPerson = useCreatePerson();
  const deletePerson = useDeletePerson();

  const handleAddPerson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonName.trim()) return;

    createPerson.mutate({ data: { name: newPersonName.trim() } }, {
      onSuccess: () => {
        setNewPersonName("");
        queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        toast({ title: "Person added successfully" });
      },
      onError: () => {
        toast({ title: "Failed to add person", variant: "destructive" });
      }
    });
  };

  const handleDeletePerson = (id: number) => {
    if (!confirm("Are you sure you want to remove this person?")) return;
    
    deletePerson.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        toast({ title: "Person removed" });
      },
      onError: () => {
        toast({ title: "Failed to remove person", variant: "destructive" });
      }
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Team</h1>

      <Card className="mb-8 border-primary/20 bg-primary/5">
        <CardContent className="p-4">
          <form onSubmit={handleAddPerson} className="flex gap-2">
            <div className="relative flex-1">
              <UserPlus className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input 
                value={newPersonName}
                onChange={e => setNewPersonName(e.target.value)}
                placeholder="Worker name..." 
                className="pl-10 h-14 text-base bg-background" 
              />
            </div>
            <Button type="submit" disabled={!newPersonName.trim() || createPerson.isPending} className="h-14 px-6">
              <Plus className="h-5 w-5 md:mr-2" />
              <span className="hidden md:inline">Add</span>
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)
        ) : people && people.length > 0 ? (
          people.map(person => (
            <Card key={person.id} className="hover:bg-muted/50 transition-colors">
              <CardContent className="p-4 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-full text-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <span className="font-medium text-lg">{person.name}</span>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => handleDeletePerson(person.id)}
                  disabled={deletePerson.isPending}
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-xl border-muted">
            <User className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>No team members added yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
