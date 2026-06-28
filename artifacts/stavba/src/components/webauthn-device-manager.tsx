import { useState } from "react";
import { format } from "date-fns";
import { cs } from "date-fns/locale";
import { startRegistration } from "@simplewebauthn/browser";
import {
  useWebauthnRegisterBegin,
  useWebauthnRegisterComplete,
  useListWebAuthnCredentials,
  useDeleteWebAuthnCredential,
  getListWebAuthnCredentialsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Fingerprint, Plus, Trash2, Loader2, Smartphone } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

interface WebAuthnDeviceManagerProps {
  userId?: number;
  readOnly?: boolean;
  title?: string;
}

export function WebAuthnDeviceManager({ userId, readOnly = false, title = "Biometrické přihlášení" }: WebAuthnDeviceManagerProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { openConfirm, dialogProps } = useConfirmDialog();

  const queryParams = userId ? { userId } : undefined;
  const queryKey = getListWebAuthnCredentialsQueryKey(queryParams);

  const { data: credentials, isLoading } = useListWebAuthnCredentials(queryParams, {
    query: { queryKey },
  });

  const registerBegin = useWebauthnRegisterBegin();
  const registerComplete = useWebauthnRegisterComplete();
  const deleteCred = useDeleteWebAuthnCredential();

  const [adding, setAdding] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [registering, setRegistering] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey });

  const handleRegister = async () => {
    if (!deviceName.trim()) {
      toast({ title: "Zadejte název zařízení", variant: "destructive" });
      return;
    }
    setRegistering(true);
    try {
      const options = await registerBegin.mutateAsync(undefined);

      let attResp;
      try {
        attResp = await startRegistration({ optionsJSON: options as any });
      } catch (err: any) {
        if (err?.name === "NotAllowedError") {
          toast({ title: "Registrace zrušena", description: "Biometrické ověření bylo zrušeno nebo zamítnuto." });
        } else {
          toast({ title: "Registrace selhala", description: err?.message ?? "Zkuste to znovu.", variant: "destructive" });
        }
        return;
      }

      await registerComplete.mutateAsync({
        data: { response: attResp as any, deviceName: deviceName.trim() },
      });

      localStorage.setItem("webauthn_registered", "1");
      toast({ title: "Zařízení zaregistrováno", description: `„${deviceName}" je nyní aktivní pro biometrické přihlášení.` });
      setAdding(false);
      setDeviceName("");
      refresh();
    } catch (err: any) {
      toast({ title: "Registrace selhala", description: err?.message ?? "Zkuste to znovu.", variant: "destructive" });
    } finally {
      setRegistering(false);
    }
  };

  const handleDelete = (id: number, name: string | null) => {
    openConfirm(
      {
        title: `Odebrat zařízení${name ? ` „${name}"` : ""}?`,
        description: "Tato akce zabrání přihlášení přes biometriku z tohoto zařízení.",
      },
      () => {
        deleteCred.mutate(
          { id },
          {
            onSuccess: () => {
              refresh();
              if (!userId) {
                const remaining = (credentials?.length ?? 0) - 1;
                if (remaining <= 0) localStorage.removeItem("webauthn_registered");
              }
              toast({ title: "Zařízení odebráno" });
            },
            onError: (err: any) =>
              toast({ title: "Odebrání selhalo", description: err?.message, variant: "destructive" }),
          },
        );
      },
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-violet-500" />
          {title}
        </h3>
        {!readOnly && !adding && !userId && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3 mr-1" /> Přidat toto zařízení
          </Button>
        )}
      </div>

      {adding && !readOnly && (
        <div className="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-lg p-3 mb-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Pojmenujte toto zařízení a pak potvrďte biometrikou (otisk / Face ID).
          </p>
          <div className="flex gap-2">
            <Input
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Např. Můj telefon"
              className="h-9 text-sm"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") void handleRegister(); }}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleRegister()}
              disabled={registering}
              className="h-8"
            >
              {registering ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Fingerprint className="h-3.5 w-3.5 mr-1" />
              )}
              Registrovat
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setAdding(false); setDeviceName(""); }}
              className="h-8"
            >
              Zrušit
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-2">Načítám…</p>
      ) : credentials?.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">Žádná biometrická zařízení nejsou registrována.</p>
      ) : (
        <ul className="space-y-2">
          {credentials?.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 p-2 bg-muted/40 rounded-lg">
              <div className="flex items-center gap-2 min-w-0">
                <Smartphone className="h-4 w-4 text-violet-500 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{c.deviceName ?? "Zařízení"}</div>
                  <div className="text-xs text-muted-foreground">
                    Registrováno {format(new Date(c.createdAt), "d. M. yyyy", { locale: cs })}
                  </div>
                </div>
              </div>
              {!readOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                  onClick={() => handleDelete(c.id, c.deviceName ?? null)}
                  title="Odebrat zařízení"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
