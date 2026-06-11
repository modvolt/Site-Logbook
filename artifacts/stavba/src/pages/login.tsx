import { useState } from "react";
import { useLocation } from "wouter";
import { Briefcase, LogIn, ShieldAlert, RotateCw, KeyRound, ArrowLeft, Loader2 } from "lucide-react";
import {
  useLogin,
  useSetupFirstAdmin,
  useForgotPasswordQuestions,
  useResetPasswordWithAnswers,
  type SecurityQuestionItem,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { debugLog, hardRefreshApp } from "@/lib/pwa";

function ForgotPasswordFlow({ onBack }: { onBack: () => void }) {
  const { toast } = useToast();
  const fetchQuestions = useForgotPasswordQuestions();
  const reset = useResetPasswordWithAnswers();

  const [username, setUsername] = useState("");
  const [questions, setQuestions] = useState<SecurityQuestionItem[] | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  const handleFetch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    fetchQuestions.mutate(
      { data: { username: username.trim() } },
      {
        onSuccess: (data) => {
          const sorted = [...data.questions].sort((a, b) => a.position - b.position);
          setQuestions(sorted);
          setAnswers(sorted.map(() => ""));
        },
        onError: () =>
          toast({
            title: "Obnova není dostupná",
            description: "Pro tento účet nejsou nastavené bezpečnostní otázky.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleReset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!questions) return;
    if (answers.some((a) => !a.trim())) {
      toast({ title: "Odpovězte na všechny otázky", variant: "destructive" });
      return;
    }
    if (newPassword.length < 6) {
      toast({ title: "Nové heslo musí mít aspoň 6 znaků", variant: "destructive" });
      return;
    }
    if (newPassword !== newPassword2) {
      toast({ title: "Hesla se neshodují", variant: "destructive" });
      return;
    }
    reset.mutate(
      {
        data: {
          username: username.trim(),
          answers: questions.map((q, i) => ({ position: q.position, answer: answers[i] })),
          newPassword,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Heslo bylo změněno", description: "Přihlaste se novým heslem." });
          onBack();
        },
        onError: () =>
          toast({
            title: "Obnova selhala",
            description: "Odpovědi nejsou správné.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Zpět na přihlášení
      </button>
      <div className="bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-900 rounded-lg p-3 text-sm flex gap-2 mb-4">
        <KeyRound className="w-5 h-5 text-violet-600 shrink-0" />
        <div>
          <p className="font-medium">Obnova hesla</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dostupné jen pro administrátorský účet s nastavenými otázkami.
          </p>
        </div>
      </div>

      {!questions ? (
        <form onSubmit={handleFetch} className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1">Uživatelské jméno</label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoFocus />
          </div>
          <Button type="submit" disabled={fetchQuestions.isPending} className="w-full h-11">
            {fetchQuestions.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <KeyRound className="w-4 h-4 mr-2" />}
            Pokračovat
          </Button>
        </form>
      ) : (
        <form onSubmit={handleReset} className="space-y-4">
          {questions.map((q, i) => (
            <div key={q.position}>
              <label className="text-sm font-medium block mb-1">{q.question}</label>
              <Input
                value={answers[i]}
                onChange={(e) => setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                required
                autoComplete="off"
              />
            </div>
          ))}
          <div>
            <label className="text-sm font-medium block mb-1">Nové heslo <span className="text-xs text-muted-foreground">(min. 6 znaků)</span></label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required autoComplete="new-password" />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Nové heslo znovu</label>
            <Input type="password" value={newPassword2} onChange={(e) => setNewPassword2(e.target.value)} minLength={6} required autoComplete="new-password" />
          </div>
          <Button type="submit" disabled={reset.isPending} className="w-full h-11">
            {reset.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <KeyRound className="w-4 h-4 mr-2" />}
            Změnit heslo
          </Button>
        </form>
      )}
    </div>
  );
}

export default function Login() {
  const { needsSetup, refresh } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const login = useLogin();
  const setup = useSetupFirstAdmin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showForgot, setShowForgot] = useState(false);

  // After a successful login/setup, re-check /api/auth/me and send the user
  // straight to the dashboard ("/"), so the router never lingers on the login
  // view and the entry point matches the PWA start_url.
  const goToApp = () => {
    debugLog("auth", "login success → redirect to dashboard (/)");
    refresh();
    setLocation("/");
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    debugLog("auth", "login attempt");
    login.mutate({ data: { username, password } }, {
      onSuccess: () => { goToApp(); toast({ title: `Vítej, ${username}` }); },
      onError: () => toast({ title: "Přihlášení selhalo", description: "Špatné jméno nebo heslo", variant: "destructive" }),
    });
  };

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || !name) return;
    if (password.length < 6) { toast({ title: "Heslo musí mít aspoň 6 znaků", variant: "destructive" }); return; }
    setup.mutate({ data: { username, password, name, email: email || null } }, {
      onSuccess: () => { goToApp(); toast({ title: "Admin účet vytvořen" }); },
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

        {showForgot && !needsSetup ? (
          <ForgotPasswordFlow onBack={() => setShowForgot(false)} />
        ) : needsSetup ? (
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
            <button
              type="button"
              onClick={() => setShowForgot(true)}
              className="block w-full text-center text-sm text-primary hover:underline pt-1"
            >
              Zapomenuté heslo?
            </button>
            <p className="text-xs text-muted-foreground text-center pt-2">
              Email se používá jen pro notifikace, ne pro přihlášení.
            </p>
          </form>
        )}

        <div className="mt-6 pt-4 border-t text-center">
          <button
            type="button"
            onClick={() => { void hardRefreshApp(); }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCw className="w-3.5 h-3.5" /> Obnovit aplikaci
          </button>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            Pokud appka zobrazuje starou verzi nebo se nedaří přihlásit.
          </p>
        </div>
      </div>
    </div>
  );
}
