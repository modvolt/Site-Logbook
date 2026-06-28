import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import { format, formatDistanceToNow } from "date-fns";
import { cs } from "date-fns/locale";
import {
  useListAllSessions,
  getListAllSessionsQueryKey,
  useDeleteSession,
  useDeleteUserSessions,
  getListMySessionsQueryKey,
  type SessionEntry,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Monitor, Smartphone, Laptop, LogOut, Trash2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

function DeviceIcon({ ua }: { ua: string | null }) {
  const s = ua ?? "";
  if (/iPhone|iPad|Android/i.test(s)) return <Smartphone className="w-4 h-4" />;
  if (/Macintosh|Mac/i.test(s)) return <Laptop className="w-4 h-4" />;
  return <Monitor className="w-4 h-4" />;
}

function SessionRow({
  session,
  onRevoke,
  onRevokeAll,
  isRevoking,
}: {
  session: SessionEntry;
  onRevoke: (sid: string, isSelf: boolean) => void;
  onRevokeAll: (userId: number, name: string) => void;
  isRevoking: boolean;
}) {
  const lastActive = session.lastActiveAt
    ? formatDistanceToNow(new Date(session.lastActiveAt), { addSuffix: true, locale: cs })
    : "—";
  const createdAt = session.createdAt
    ? format(new Date(session.createdAt), "d. M. yyyy HH:mm")
    : "—";

  return (
    <tr className={`border-t ${session.isCurrent ? "bg-emerald-50/60 dark:bg-emerald-950/20" : "hover:bg-muted/30"}`}>
      <td className="px-3 py-3">
        <div className="font-medium text-sm">
          {session.name ?? "—"}
          {session.isCurrent && (
            <span className="ml-2 text-xs text-emerald-600 font-semibold bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 rounded-full">
              tato session
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground font-mono">{session.username ?? "—"}</div>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2 text-sm">
          <DeviceIcon ua={session.userAgent ?? null} />
          <span>{session.userAgentParsed}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{session.ipAddress ?? "—"}</div>
      </td>
      <td className="px-3 py-3 text-sm">
        <div>{lastActive}</div>
        <div className="text-xs text-muted-foreground">Přihlášení: {createdAt}</div>
      </td>
      <td className="px-3 py-3">
        <div className="flex gap-1 justify-end">
          {session.isCurrent ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/20" title="Ukončit vlastní session">
                  <LogOut className="w-3.5 h-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                    Ukončit vlastní session?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Toto je vaše aktuální přihlášení. Budete okamžitě odhlášeni a přesměrováni na přihlašovací stránku.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Zrušit</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onRevoke(session.sid, true)}
                    className="bg-amber-600 hover:bg-amber-700"
                    disabled={isRevoking}
                  >
                    Odhlásit se
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRevoke(session.sid, false)}
              disabled={isRevoking}
              className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
              title="Ukončit session"
            >
              <LogOut className="w-3.5 h-3.5" />
            </Button>
          )}
          {session.userId != null && !session.isCurrent && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRevokeAll(session.userId!, session.name ?? session.username ?? "?")}
              disabled={isRevoking}
              className="h-8 px-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="Odhlásit všude"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function AdminSessions() {
  useLiveUpdates();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { openConfirm, dialogProps } = useConfirmDialog();
  const [search, setSearch] = useState("");

  const queryKey = getListAllSessionsQueryKey({});
  const { data: sessions, isLoading, error } = useListAllSessions({}, { query: { queryKey } });

  const deleteSession = useDeleteSession();
  const deleteUserSessions = useDeleteUserSessions();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListAllSessionsQueryKey({}) });
    void queryClient.invalidateQueries({ queryKey: getListMySessionsQueryKey() });
  };

  const handleRevoke = (sid: string, isSelf: boolean) => {
    deleteSession.mutate({ sid }, {
      onSuccess: () => {
        refresh();
        if (isSelf) {
          window.location.href = "/";
        } else {
          toast({ title: "Session ukončena" });
        }
      },
      onError: (err: any) => toast({ title: "Chyba", description: err?.message, variant: "destructive" }),
    });
  };

  const handleRevokeAll = (userId: number, name: string) => {
    openConfirm(
      {
        title: `Odhlásit „${name}" ze všech zařízení?`,
        description: "Všechna přihlášení tohoto uživatele budou okamžitě ukončena. Aktuální vaše přihlášení zůstane zachováno.",
      },
      () => {
        deleteUserSessions.mutate({ id: userId }, {
          onSuccess: () => {
            refresh();
            toast({ title: `${name} odhlášen ze všech zařízení` });
          },
          onError: (err: any) => toast({ title: "Chyba", description: err?.message, variant: "destructive" }),
        });
      },
    );
  };

  const filtered = (sessions ?? []).filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.username?.toLowerCase().includes(q) ||
      s.name?.toLowerCase().includes(q) ||
      s.ipAddress?.toLowerCase().includes(q) ||
      s.userAgentParsed.toLowerCase().includes(q)
    );
  });

  const grouped = filtered.reduce<Record<string, SessionEntry[]>>((acc, s) => {
    const key = s.username ?? "Neznámý";
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const isRevoking = deleteSession.isPending || deleteUserSessions.isPending;

  return (
    <div className="p-4 md:p-6 w-full">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <Monitor className="w-7 h-7 text-rose-600" />
            <h1 className="text-2xl font-bold">Aktivní přihlášení</h1>
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Hledat uživatele, IP..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-52 h-9"
            />
            <Button variant="outline" size="sm" onClick={refresh} className="h-9">
              Obnovit
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Přehled všech aktivních přihlášení. Ukončením session dojde k okamžitému odhlášení daného zařízení.
        </p>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : error ? (
          <div className="text-destructive text-sm">Nepodařilo se načíst session.</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {search ? "Žádné výsledky pro daný filtr." : "Žádné aktivní přihlášení."}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([username, userSessions]) => (
              <div key={username} className="bg-card border rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-muted/40 flex items-center justify-between">
                  <span className="font-semibold text-sm">
                    {userSessions[0].name ?? username}
                    <span className="text-muted-foreground font-normal ml-2 font-mono text-xs">@{username}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{userSessions.length} {userSessions.length === 1 ? "session" : "session"}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/20 text-xs uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Uživatel</th>
                        <th className="px-3 py-2 text-left">Zařízení / Prohlížeč</th>
                        <th className="px-3 py-2 text-left">Aktivita</th>
                        <th className="px-3 py-2 w-24"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {userSessions.map((s) => (
                        <SessionRow
                          key={s.sid}
                          session={s}
                          onRevoke={handleRevoke}
                          onRevokeAll={handleRevokeAll}
                          isRevoking={isRevoking}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
