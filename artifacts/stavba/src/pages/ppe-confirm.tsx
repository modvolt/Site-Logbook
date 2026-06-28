import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface AssignmentDetails {
  id: number;
  ppeNameSnapshot: string;
  personNameSnapshot: string;
  quantity: number;
  issuedAt: string;
  size: string | null;
  serialNumber: string | null;
  employeeConfirmedAt: string | null;
  status: string;
}

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; assignment: AssignmentDetails }
  | { kind: "confirming"; assignment: AssignmentDetails }
  | { kind: "done"; alreadyConfirmed: boolean; assignment: AssignmentDetails };

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });
}

export default function PpeConfirm() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";

  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "Odkaz neobsahuje platný token." });
      return;
    }
    fetch(`/api/ppe/confirm?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: "Neznámá chyba" }));
          throw new Error(body.error ?? "Chyba při načítání");
        }
        return r.json() as Promise<AssignmentDetails>;
      })
      .then((assignment) => {
        if (assignment.employeeConfirmedAt) {
          setState({ kind: "done", alreadyConfirmed: true, assignment });
        } else {
          setState({ kind: "ready", assignment });
        }
      })
      .catch((err) => setState({ kind: "error", message: err.message }));
  }, [token]);

  const handleConfirm = async () => {
    if (state.kind !== "ready") return;
    setState({ kind: "confirming", assignment: state.assignment });
    try {
      const r = await fetch("/api/ppe/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Neznámá chyba" }));
        setState({ kind: "error", message: body.error ?? "Chyba při potvrzování" });
        return;
      }
      const result = await r.json() as { already: boolean; assignment: AssignmentDetails };
      setState({ kind: "done", alreadyConfirmed: result.already, assignment: result.assignment });
    } catch {
      setState({ kind: "error", message: "Nepodařilo se odeslat potvrzení. Zkuste to znovu." });
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-6">
          <ShieldCheck className="h-8 w-8 text-primary" />
          <span className="text-2xl font-bold">Potvrzení OOPP</span>
        </div>

        {state.kind === "loading" && (
          <Card>
            <CardContent className="p-8 flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p>Načítám…</p>
            </CardContent>
          </Card>
        )}

        {state.kind === "error" && (
          <Card className="border-destructive/40">
            <CardContent className="p-8 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="h-10 w-10 text-destructive" />
              <p className="font-semibold text-destructive">Odkaz není platný</p>
              <p className="text-sm text-muted-foreground">{state.message}</p>
            </CardContent>
          </Card>
        )}

        {(state.kind === "ready" || state.kind === "confirming") && (
          <Card>
            <CardContent className="p-6 space-y-5">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Zaměstnanec</p>
                <p className="font-semibold text-lg">{state.assignment.personNameSnapshot}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">Vydaná pomůcka</p>
                <p className="font-semibold text-lg">{state.assignment.ppeNameSnapshot}</p>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground mb-0.5">Datum výdeje</p>
                  <p className="font-medium">{formatDate(state.assignment.issuedAt)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Počet</p>
                  <p className="font-medium">{state.assignment.quantity} ks</p>
                </div>
                {state.assignment.size && (
                  <div>
                    <p className="text-muted-foreground mb-0.5">Velikost</p>
                    <p className="font-medium">{state.assignment.size}</p>
                  </div>
                )}
                {state.assignment.serialNumber && (
                  <div>
                    <p className="text-muted-foreground mb-0.5">Sériové číslo</p>
                    <p className="font-medium">{state.assignment.serialNumber}</p>
                  </div>
                )}
              </div>

              <div className="pt-2 border-t">
                <p className="text-sm text-muted-foreground mb-4">
                  Kliknutím níže potvrdíte, že jste výše uvedené osobní ochranné pracovní prostředky (OOPP) převzali v dobrém stavu.
                </p>
                <Button
                  className="w-full h-12 text-base"
                  onClick={handleConfirm}
                  disabled={state.kind === "confirming"}
                >
                  {state.kind === "confirming" ? (
                    <>
                      <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                      Odesílám…
                    </>
                  ) : (
                    <>
                      <ClipboardCheck className="h-5 w-5 mr-2" />
                      Potvrzuji převzetí OOPP
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {state.kind === "done" && (
          <Card className="border-green-500/40">
            <CardContent className="p-8 flex flex-col items-center gap-4 text-center">
              <CheckCircle2 className="h-14 w-14 text-green-500" />
              <div>
                <p className="font-semibold text-lg">
                  {state.alreadyConfirmed ? "Již potvrzeno" : "Potvrzeno!"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {state.alreadyConfirmed
                    ? "Tento výdej byl již dříve potvrzen."
                    : `Převzetí pomůcky „${state.assignment.ppeNameSnapshot}" bylo úspěšně potvrzeno.`}
                </p>
              </div>
              {state.assignment.employeeConfirmedAt && (
                <p className="text-xs text-muted-foreground">
                  Potvrzeno: {formatDate(state.assignment.employeeConfirmedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
