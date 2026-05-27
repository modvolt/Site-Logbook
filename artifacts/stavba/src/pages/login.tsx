import { useState } from "react";
import { Briefcase, LogIn, ShieldAlert } from "lucide-react";
import { useLogin, useSetupFirstAdmin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

export default function Login() {
  const { needsSetup, refresh } = useAuth();
  const { toast } = useToast();
  const login = useLogin();
  const setup = useSetupFirstAdmin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    login.mutate({ data: { username, password } }, {
      onSuccess: () => { refresh(); toast({ title: `Vítej, ${username}` }); },
      onError: () => toast({ title: "Přihlášení selhalo", description: "Špatné jméno nebo heslo", variant: "destructive" }),
    });
  };

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || !name) return;
    if (password.length < 6) { toast({ title: "Heslo musí mít aspoň 6 znaků", variant: "destructive" }); return; }
    setup.mutate({ data: { username, password, name, email: email || null } }, {
      onSuccess: () => { refresh(); toast({ title: "Admin účet vytvořen" }); },
      onError: (err: any) => toast({ title: "Nepodařilo se vytvořit účet", description: err?.message, variant: "destructive" }),
    });
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-amber-50 via-background to-violet-50 dark:from-amber-950/20 dark:to-violet-950/20 p-4">
      <div className="w-full max-w-md bg-card border rounded-2xl shadow-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center">
            <Briefcase className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Stavba</h1>
            <p className="text-xs text-muted-foreground">Job Tracker</p>
          </div>
        </div>

        {needsSetup ? (
          <form onSubmit={handleSetup} className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg p-3 text-sm flex gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
              <div>
                <p className="font-medium">První spuštění</p>
                <p className="text-xs text-muted-foreground mt-0.5">Vytvořte prosím první admin účet.</p>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Jméno *</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Jan Novák" required />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Uživatelské jméno *</label>
              <Input value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" minLength={3} required autoComplete="username" />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Heslo * <span className="text-xs text-muted-foreground">(min. 6 znaků)</span></label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={6} required autoComplete="new-password" />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Email <span className="text-xs text-muted-foreground">(volitelně, pro notifikace)</span></label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.cz" autoComplete="email" />
            </div>
            <Button type="submit" disabled={setup.isPending} className="w-full h-11">
              <ShieldAlert className="w-4 h-4 mr-2" /> Vytvořit admin účet
            </Button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-sm font-medium block mb-1">Uživatelské jméno</label>
              <Input value={username} onChange={e => setUsername(e.target.value)} required autoComplete="username" autoFocus />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Heslo</label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            <Button type="submit" disabled={login.isPending} className="w-full h-11">
              <LogIn className="w-4 h-4 mr-2" /> Přihlásit se
            </Button>
            <p className="text-xs text-muted-foreground text-center pt-2">
              Email se používá jen pro notifikace, ne pro přihlášení.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
