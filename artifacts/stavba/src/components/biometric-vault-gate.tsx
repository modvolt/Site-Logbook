import { useState, useEffect, useCallback } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import {
  useWebauthnVerifyBegin,
  useWebauthnVerifyComplete,
  useVerifyVaultPassword,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Fingerprint, Loader2, ShieldCheck, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BIOMETRIC_TTL_MS = 5 * 60 * 1000;

interface BiometricVaultGateProps {
  onVerified: () => void;
}

export function BiometricVaultGate({ onVerified }: BiometricVaultGateProps) {
  const { toast } = useToast();
  const [verifying, setVerifying] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordVerifying, setPasswordVerifying] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);

  const verifyBegin = useWebauthnVerifyBegin();
  const verifyComplete = useWebauthnVerifyComplete();
  const verifyPassword = useVerifyVaultPassword();

  const updateRemaining = useCallback((at: number) => {
    const ms = BIOMETRIC_TTL_MS - (Date.now() - at);
    setRemainingSec(Math.max(0, Math.ceil(ms / 1000)));
  }, []);

  useEffect(() => {
    if (!verifiedAt) return;
    updateRemaining(verifiedAt);
    const id = setInterval(() => {
      const ms = BIOMETRIC_TTL_MS - (Date.now() - verifiedAt);
      if (ms <= 0) {
        setVerifiedAt(null);
        setRemainingSec(0);
      } else {
        setRemainingSec(Math.ceil(ms / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [verifiedAt, updateRemaining]);

  const markVerified = (description: string) => {
    const now = Date.now();
    setVerifiedAt(now);
    updateRemaining(now);
    setPassword("");
    onVerified();
    toast({ title: "Trezor ověřen", description });
  };

  const handleBiometricVerify = async () => {
    setVerifying(true);
    try {
      const options = await verifyBegin.mutateAsync(undefined);
      let authResp;
      try {
        authResp = await startAuthentication({ optionsJSON: options as any });
      } catch (err: any) {
        if (err?.name === "NotAllowedError") {
          toast({ title: "Ověření zrušeno" });
        } else {
          toast({ title: "Ověření selhalo", description: err?.message, variant: "destructive" });
        }
        return;
      }

      await verifyComplete.mutateAsync({ data: { response: authResp as any } });
      markVerified("Biometrické ověření platí v této session 5 minut.");
    } catch (err: any) {
      toast({ title: "Ověření selhalo", description: err?.message ?? "Zkuste to znovu.", variant: "destructive" });
    } finally {
      setVerifying(false);
    }
  };

  const handlePasswordVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setPasswordVerifying(true);
    try {
      await verifyPassword.mutateAsync({ data: { password } });
      markVerified("Ověření heslem platí v této session 5 minut.");
    } catch (err: any) {
      toast({
        title: "Ověření selhalo",
        description: err?.message ?? "Zkontrolujte heslo a zkuste to znovu.",
        variant: "destructive",
      });
    } finally {
      setPasswordVerifying(false);
    }
  };

  if (verifiedAt && remainingSec > 0) {
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-3 py-2">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span className="font-medium">Trezor ověřen</span>
        <span className="ml-auto flex items-center gap-1 text-xs">
          <Clock className="h-3 w-3" />
          {m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-lg p-4 flex flex-col items-center gap-3 text-center">
      <ShieldCheck className="h-10 w-10 text-violet-500" />
      <div>
        <p className="font-semibold text-sm">Přístup do trezoru vyžaduje opětovné ověření</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Použijte biometriku nebo své aktuální heslo. Ověření platí 5 minut v této session.
        </p>
      </div>
      <div className="w-full max-w-sm space-y-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleBiometricVerify()}
          disabled={verifying || passwordVerifying}
          className="h-10 w-full"
        >
          {verifying ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Fingerprint className="h-4 w-4 mr-2" />
          )}
          Ověřit biometrikou
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          nebo
          <span className="h-px flex-1 bg-border" />
        </div>
        <form onSubmit={(event) => void handlePasswordVerify(event)} className="flex gap-2">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Aktuální heslo"
            aria-label="Aktuální heslo"
            disabled={verifying || passwordVerifying}
          />
          <Button
            type="submit"
            disabled={!password || verifying || passwordVerifying}
            className="h-10 shrink-0"
          >
            {passwordVerifying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Ověřit
          </Button>
        </form>
      </div>
    </div>
  );
}
