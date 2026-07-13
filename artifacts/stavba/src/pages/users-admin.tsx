import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  useListUsers, getListUsersQueryKey,
  useListPeople, getListPeopleQueryKey,
  useCreateUser, useUpdateUser, useDeleteUser,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Plus, Trash2, Save, X, Edit3, Key, ShieldCheck, Hammer, Eye, Monitor, Fingerprint, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { WebAuthnDeviceManager } from "@/components/webauthn-device-manager";
import { QueryErrorState } from "@/components/query-error-state";
import { UserPermissionEditor } from "@/components/user-permission-editor";

const ROLE_META: Record<string, { label: string; color: string; icon: any; desc: string }> = {
  admin: { label: "Admin", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300", icon: ShieldCheck, desc: "Plný přístup + správa uživatelů" },
  master: { label: "Master", color: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300", icon: Hammer, desc: "Může upravovat zakázky" },
  guest:  { label: "Guest", color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", icon: Eye, desc: "Pouze prohlížení" },
};

export default function UsersAdmin() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const { data: users, isLoading, isError, error, refetch } = useListUsers({ query: { queryKey: getListUsersQueryKey() } });
  const { data: people = [] } = useListPeople({ query: { queryKey: getListPeopleQueryKey() } });

  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", name: "", email: "", personId: "none", role: "guest" });
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [permissionsUserId, setPermissionsUserId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", email: "", personId: "none", role: "guest", isActive: true, password: "" });
  const [editError, setEditError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const handleCreate = () => {
    if (!newUser.username || !newUser.password || !newUser.name) {
      setCreateError("Vyplňte jméno, uživatelské jméno a heslo.");
      return;
    }
    if (newUser.password.length < 6) { setCreateError("Heslo musí mít aspoň 6 znaků."); return; }
    setCreateError(null);
    createUser.mutate({
      data: {
        username: newUser.username,
        password: newUser.password,
        name: newUser.name,
        email: newUser.email || null,
        personId: newUser.personId === "none" ? null : Number(newUser.personId),
        role: newUser.role,
        isActive: true,
      },
    }, {
      onSuccess: () => {
        refresh();
        setShowCreate(false);
        setNewUser({ username: "", password: "", name: "", email: "", personId: "none", role: "guest" });
        setCreateError(null);
        toast({ title: "Uživatel vytvořen" });
      },
      onError: (err: any) => setCreateError(err?.message ?? "Vytvoření selhalo."),
    });
  };

  const startEdit = (u: any) => {
    setEditingId(u.id);
    setEditDraft({ name: u.name, email: u.email || "", personId: u.personId == null ? "none" : String(u.personId), role: u.role, isActive: u.isActive, password: "" });
  };

  const saveEdit = () => {
    if (editingId == null) return;
    if (editDraft.password && editDraft.password.length < 6) { setEditError("Heslo musí mít aspoň 6 znaků."); return; }
    setEditError(null);
    const data: any = {
      name: editDraft.name,
      email: editDraft.email || null,
      personId: editDraft.personId === "none" ? null : Number(editDraft.personId),
      role: editDraft.role,
      isActive: editDraft.isActive,
    };
    if (editDraft.password) data.password = editDraft.password;
    updateUser.mutate({ id: editingId, data }, {
      onSuccess: () => {
        refresh();
        setEditingId(null);
        setEditError(null);
        toast({ title: "Uloženo" });
      },
      onError: (err: any) => setEditError(err?.message ?? "Uložení selhalo."),
    });
  };

  const handleDelete = (id: number, username: string) => {
    openConfirm(
      { title: `Smazat uživatele „${username}"?`, description: "Tato akce je nevratná." },
      () => {
        deleteUser.mutate({ id }, {
          onSuccess: () => { refresh(); toast({ title: "Uživatel smazán" }); },
          onError: (err: any) => toast({ title: "Smazání selhalo", description: err?.message, variant: "destructive" }),
        });
      },
    );
  };

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <Users className="w-7 h-7 text-rose-600" />
            <h1 className="text-2xl font-bold">Správa uživatelů</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin/sessions">
              <Button variant="outline" size="sm" className="h-9">
                <Monitor className="w-4 h-4 mr-1" /> Aktivní přihlášení
              </Button>
            </Link>
            <Button onClick={() => setShowCreate(s => !s)} disabled={isLoading || isError}>
              <Plus className="w-4 h-4 mr-1" /> Nový uživatel
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Spravujte přístupy a role pro celou aplikaci.
        </p>

        {/* Role legend */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {Object.entries(ROLE_META).map(([key, m]) => {
            const Icon = m.icon;
            return (
              <div key={key} className="border rounded-xl p-3 bg-card flex items-start gap-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${m.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-sm">{m.label}</p>
                  <p className="text-xs text-muted-foreground">{m.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="bg-card border rounded-xl p-4 mb-4 space-y-3">
            <h2 className="font-semibold">Nový uživatel</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Jméno *</label>
                <Input value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} placeholder="Jan Novák" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Uživatelské jméno *</label>
                <Input value={newUser.username} onChange={e => setNewUser({ ...newUser, username: e.target.value })} placeholder="jnovak" minLength={3} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Heslo * (min. 6 znaků)</label>
                <Input type="password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                <Input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} placeholder="pro notifikace" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Zaměstnanec pro měření času</label>
                <Select value={newUser.personId} onValueChange={value => setNewUser({ ...newUser, personId: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nepřiřazeno</SelectItem>
                    {people.map(person => <SelectItem key={person.id} value={String(person.id)}>{person.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Role *</label>
                <Select value={newUser.role} onValueChange={v => setNewUser({ ...newUser, role: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(ROLE_META).map(([k, m]) => (
                      <SelectItem key={k} value={k}>{m.label} — {m.desc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {createError && (
              <p className="text-destructive text-sm" role="alert">{createError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => { setShowCreate(false); setCreateError(null); }}>Zrušit</Button>
              <Button onClick={handleCreate} disabled={createUser.isPending}>
                <Plus className="w-4 h-4 mr-1" /> Vytvořit
              </Button>
            </div>
          </div>
        )}

        {/* Users list */}
        {isError ? (
          <QueryErrorState
            title="Nepodařilo se načíst uživatele"
            error={error}
            onRetry={() => refetch()}
          />
        ) : (
        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 text-left">Jméno</th>
                  <th className="px-3 py-3 text-left">Uživatel</th>
                  <th className="px-3 py-3 text-left">Email</th>
                  <th className="px-3 py-3 text-left">Zaměstnanec</th>
                  <th className="px-3 py-3 text-left">Role</th>
                  <th className="px-3 py-3 text-left">Stav</th>
                  <th className="px-3 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [1, 2, 3].map(i => (
                    <tr key={i} className="border-t"><td colSpan={7} className="px-3 py-2"><Skeleton className="h-8 w-full" /></td></tr>
                  ))
                ) : users?.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">Žádní uživatelé</td></tr>
                ) : users?.map(u => {
                  const isEditing = editingId === u.id;
                  const meta = ROLE_META[u.role] || ROLE_META.guest;
                  const isSelf = u.id === me?.id;
                  if (isEditing) {
                    return (
                      <tr key={u.id} className="border-t bg-amber-50/50 dark:bg-amber-950/20">
                        <td className="px-2 py-2">
                          <Input value={editDraft.name} onChange={e => setEditDraft({ ...editDraft, name: e.target.value })} className="h-9 text-sm" />
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{u.username}</td>
                        <td className="px-2 py-2">
                          <Input type="email" value={editDraft.email} onChange={e => setEditDraft({ ...editDraft, email: e.target.value })} className="h-9 text-sm" placeholder="email" />
                        </td>
                        <td className="px-2 py-2 min-w-48">
                          <Select value={editDraft.personId} onValueChange={value => setEditDraft({ ...editDraft, personId: value })}>
                            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Nepřiřazeno</SelectItem>
                              {people.map(person => <SelectItem key={person.id} value={String(person.id)}>{person.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <Select value={editDraft.role} onValueChange={v => setEditDraft({ ...editDraft, role: v })} disabled={isSelf}>
                            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(ROLE_META).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2">
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input type="checkbox" checked={editDraft.isActive} onChange={e => setEditDraft({ ...editDraft, isActive: e.target.checked })} disabled={isSelf} className="w-4 h-4" />
                            Aktivní
                          </label>
                          <div className="mt-2 flex items-center gap-1">
                            <Key className="w-3 h-3 text-muted-foreground" />
                            <Input type="password" placeholder="Nové heslo (volitelně)" value={editDraft.password} onChange={e => setEditDraft({ ...editDraft, password: e.target.value })} className="h-7 text-xs" />
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          {editError && (
                            <p className="text-destructive text-xs mb-1" role="alert">{editError}</p>
                          )}
                          <div className="flex gap-1 justify-end">
                            <Button size="sm" onClick={saveEdit} disabled={updateUser.isPending} className="h-8 px-2">
                              <Save className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setEditError(null); }} className="h-8 px-2">
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={u.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-3 font-medium">
                        {u.name} {isSelf && <span className="text-xs text-amber-600 ml-1">(vy)</span>}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground font-mono text-xs">{u.username}</td>
                      <td className="px-3 py-3 text-muted-foreground">{u.email || "—"}</td>
                      <td className="px-3 py-3 text-muted-foreground">{people.find(person => person.id === u.personId)?.name ?? "—"}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.color}`}>
                          <meta.icon className="w-3 h-3" />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {u.isActive ? (
                          <span className="text-xs text-emerald-600 font-medium">● Aktivní</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">○ Deaktivován</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" onClick={() => startEdit(u)} className="h-8 px-2" title="Upravit">
                            <Edit3 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setPermissionsUserId(u.id)} className="h-8 px-2" title="Oprávnění">
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                          </Button>
                          {!isSelf && (
                            <Button size="sm" variant="ghost" onClick={() => handleDelete(u.id, u.username)} className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10" title="Smazat">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        )}
        {permissionsUserId != null && users && (() => {
          const permissionUser = users.find((candidate) => candidate.id === permissionsUserId);
          return permissionUser ? (
            <UserPermissionEditor user={permissionUser} currentUserId={me?.id} onClose={() => setPermissionsUserId(null)} />
          ) : null;
        })()}
      </div>
      {/* Biometric device management per user */}
      <div className="mt-6">
        <h2 className="font-semibold flex items-center gap-2 mb-3">
          <Fingerprint className="h-4 w-4 text-violet-500" />
          Biometrická zařízení uživatelů
        </h2>
        <div className="space-y-3">
          {users?.map((u) => (
            <details key={u.id} className="bg-card border rounded-xl overflow-hidden group">
              <summary className="px-4 py-3 cursor-pointer list-none flex items-center justify-between hover:bg-muted/40">
                <span className="font-medium text-sm">{u.name} <span className="text-muted-foreground font-normal">({u.username})</span></span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="px-4 pb-4 border-t pt-4">
                <WebAuthnDeviceManager userId={u.id} title="Zařízení uživatele" />
              </div>
            </details>
          ))}
        </div>
      </div>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
