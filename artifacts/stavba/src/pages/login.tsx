import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Briefcase, LogIn, ShieldAlert, RotateCw, KeyRound, ArrowLeft, Loader2, Fingerprint } from "lucide-react";
import {
  useLogin,
  useSetupFirstAdmin,
  useForgotPasswordQuestions,
  useResetPasswordWithAnswers,
  useWebauthnLoginBegin,
  useWebauthnLoginComplete,
  type SecurityQuestionItem,
} from "@workspace/api-client-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleFetch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setFetchError(null);
    fetchQuestions.mutate(
      { data: { username: username.trim() } },
      {
        onSuccess: (data) => {
          const sorted = [...data.questions].sort((a, b) => a.position - b.position);
          setQuestions(sorted);
          setAnswers(sorted.map(() => ""));
        },
        onError: () =>
          setFetchError("Pro tento účet nejsou nastavené bezpečnostní otázky."),
      },
    );
  };

  const handleReset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!questions) return;
    if (answers.some((a) => !a.trim())) {
      setResetError("Odpovězte na všechny otázky.");
      return;
    }
    if (newPassword.length < 6) {
      setResetError("Nové heslo musí mít aspoň 6 znaků.");
      return;
    }
    if (newPassword !== newPassword2) {
      setResetError("Hesla se neshodují.");
      return;
    }
    setResetError(null);
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
          setResetError("Odpovědi nejsou správné. Zkuste to znovu."),
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
            <Input
              value={username}
              onChange={(e) => { setUsername(e.target.value); if (fetchError) setFetchError(null); }}
              required
              autoComplete="username"
              autoFocus
              aria-invalid={!!fetchError}
              className={fetchError ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {fetchError && (
              <p className="text-destructive text-xs mt-1">{fetchError}</p>
            )}
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
                onChange={(e) => { setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v))); if (resetError) setResetError(null); }}
                required
                autoComplete="off"
              />
            </div>
          ))}
          <div>
            <label className="text-sm font-medium block mb-1">Nové heslo <span className="text-xs text-muted-foreground">(min. 6 znaků)</span></label>
            <Input type="password" value={newPassword} onChange={(e) => { setNewPassword(e.target.value); if (resetError) setResetError(null); }} minLength={6} required autoComplete="new-password" />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Nové heslo znovu</label>
            <Input type="password" value={newPassword2} onChange={(e) => { setNewPassword2(e.target.value); if (resetError) setResetError(null); }} minLength={6} required autoComplete="new-password" />
          </div>
          {resetError && (
            <p className="text-destructive text-sm" role="alert">{resetError}</p>
          )}
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
  const webauthnBegin = useWebauthnLoginBegin();
  const webauthnComplete = useWebauthnLoginComplete();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [setupError, setSetupError] = useState<string | null>(null);
  const [biometricLoading, setBiometricLoading] = useState(false);
  const [webauthnSupported, setWebauthnSupported] = useState(false);

  useEffect(() => {
    const hasRegistered = localStorage.getItem("webauthn_registered") === "1";
    if (hasRegistered && browserSupportsWebAuthn()) {
      setWebauthnSupported(true);
    }
  }, []);

  const goToApp = () => {
    debugLog("auth", "login success → redirect to dashboard (/)");
    refresh();
    setLocation("/");
  };

  const handleBiometricLogin = async () => {
    const trimmedUsername = username.trim();
    setBiometricLoading(true);
    try {
      const options = await webauthnBegin.mutateAsync({
        data: trimmedUsername ? { username: trimmedUsername } : {},
      });
      let authResp;
      try {
        authResp = await startAuthentication({ optionsJSON: options as any });
      } catch (err: any) {
        if (err?.name === "NotAllowedError") {
          toast({ title: "Biometrické přihlášení zrušeno" });
        } else {
          toast({ title: "Biometrické přihlášení selhalo", description: err?.message, variant: "destructive" });
        }
        return;
      }
      await webauthnComplete.mutateAsync({ data: { response: authResp as any } });
      goToApp();
      toast({ title: "Přihlášeno biometrikou" });
    } catch (err: any) {
      toast({ title: "Biometrické přihlášení selhalo", description: err?.message ?? "Zkuste se přihlásit heslem.", variant: "destructive" });
    } finally {
      setBiometricLoading(false);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!username.trim()) errs.username = "Zadejte uživatelské jméno.";
    if (!password) errs.password = "Zadejte heslo.";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    debugLog("auth", "login attempt");
    login.mutate({ data: { username: username.trim(), password } }, {
      onSuccess: () => { goToApp(); toast({ title: `Vítej, ${username}` }); },
      onError: () => {
        setFieldErrors({ password: "Špatné uživatelské jméno nebo heslo." });
      },
    });
  };

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || !name) return;
    if (password.length < 6) { setSetupError("Heslo musí mít aspoň 6 znaků."); return; }
    setSetupError(null);
    setup.mutate({ data: { username, password, name, email: email || null } }, {
      onSuccess: () => { goToApp(); toast({ title: "Admin účet vytvořen" }); },
      onError: (err: any) => setSetupError(err?.message ?? "Nepodařilo se vytvořit účet."),
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
              <Input type="password" value={password} onChange={e => { setPassword(e.target.value); if (setupError) setSetupError(null); }} minLength={6} required autoComplete="new-password" />
            </div>
            {setupError && (
              <p className="text-destructive text-sm" role="alert">{setupError}</p>
            )}
            <div>
              <label className="text-sm font-medium block mb-1">Email <span className="text-xs text-muted-foreground">(volitelně, pro notifikace)</span></label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.cz" autoComplete="email" />
            </div>
            <Button type="submit" disabled={setup.isPending} className="w-full h-11">
              <ShieldAlert className="w-4 h-4 mr-2" /> Vytvořit admin účet
            </Button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4" noValidate>
            <div>
              <label className="text-sm font-medium block mb-1">Uživatelské jméno</label>
              <Input
                value={username}
                onChange={e => { setUsername(e.target.value); if (fieldErrors.username) setFieldErrors(p => ({ ...p, username: undefined })); }}
                autoComplete="username"
                autoFocus
                aria-invalid={!!fieldErrors.username}
                className={fieldErrors.username ? "border-destructive focus-visible:ring-destructive" : ""}
              />
              {fieldErrors.username && (
                <p className="text-destructive text-xs mt-1">{fieldErrors.username}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Heslo</label>
              <Input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); if (fieldErrors.password) setFieldErrors(p => ({ ...p, password: undefined })); }}
                autoComplete="current-password"
                aria-invalid={!!fieldErrors.password}
                className={fieldErrors.password ? "border-destructive focus-visible:ring-destructive" : ""}
              />
              {fieldErrors.password && (
                <p className="text-destructive text-xs mt-1">{fieldErrors.password}</p>
              )}
            </div>
            <Button type="submit" disabled={login.isPending || biometricLoading} className="w-full h-11">
              {login.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogIn className="w-4 h-4 mr-2" />}
              Přihlásit se
            </Button>
            {webauthnSupported && (
              <Button
                type="button"
                variant="outline"
                className="w-full h-11"
                disabled={biometricLoading || login.isPending}
                onClick={() => void handleBiometricLogin()}
              >
                {biometricLoading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Fingerprint className="w-4 h-4 mr-2 text-violet-500" />
                )}
                Přihlásit biometrikou
              </Button>
            )}
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
