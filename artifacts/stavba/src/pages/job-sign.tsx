import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, PenLine, RotateCcw, Clock, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface JobSignInfo {
  jobId: number;
  title: string;
  date: string;
  customerCompanyName: string | null;
  notes: string | null;
  alreadySigned: boolean;
  signedAt: string | null;
  expired: boolean;
}

function SignatureCanvas({ onCapture }: { onCapture: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasStroke = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1e40af";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      const touch = e.touches[0];
      return { x: (touch.clientX - rect.left) * scaleX, y: (touch.clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    drawing.current = true;
    hasStroke.current = true;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.lineTo(x, y);
    ctx.stroke();
    onCapture(null);
  }

  function endDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !hasStroke.current) return;
    onCapture(canvas.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasStroke.current = false;
    onCapture(null);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        data-testid="signature-canvas"
        width={600}
        height={200}
        className="w-full border-2 border-dashed border-blue-300 rounded-lg bg-white touch-none cursor-crosshair"
        style={{ maxHeight: "200px" }}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
      <button
        type="button"
        onClick={clear}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <RotateCcw className="h-3.5 w-3.5" /> Vymazat a nakreslit znovu
      </button>
    </div>
  );
}

const SIGN_PREFIX = "/sign/";

export default function JobSign() {
  const [path] = useLocation();
  const token = path.startsWith(SIGN_PREFIX) ? path.slice(SIGN_PREFIX.length) : "";

  const [info, setInfo] = useState<JobSignInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [signedAt, setSignedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Neplatný odkaz k podpisu.");
      setLoading(false);
      return;
    }
    fetch(`/api/sign/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setInfo(data as JobSignInfo);
          if ((data as JobSignInfo).alreadySigned) {
            setDone(true);
            setSignedAt((data as JobSignInfo).signedAt);
          }
        }
      })
      .catch(() => setError("Nepodařilo se načíst informace o zakázce."))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSign() {
    if (!signatureDataUrl || !token) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Nepodařilo se odeslat podpis.");
        return;
      }
      setDone(true);
      setSignedAt(data.signedAt);
    } catch {
      setError("Nepodařilo se odeslat podpis. Zkuste to prosím znovu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-blue-50 to-white flex flex-col">
      <div className="bg-white border-b px-4 py-3 flex items-center gap-2">
        <PenLine className="h-5 w-5 text-blue-700" />
        <span className="font-semibold text-sm text-blue-900">Digitální podpis předávacího protokolu</span>
      </div>

      <div className="flex-1 p-4 max-w-lg mx-auto w-full">
        {loading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
            Načítám…
          </div>
        )}

        {!loading && error && !done && (
          <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center space-y-2">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
            <p className="text-base font-semibold text-destructive">Odkaz není platný</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        )}

        {!loading && info?.expired && !done && (
          <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-6 text-center space-y-3">
            <Clock className="h-12 w-12 text-amber-500 mx-auto" />
            <p className="text-lg font-semibold text-amber-800">Platnost odkazu vypršela</p>
            <p className="text-sm text-muted-foreground">
              Odkaz k podpisu zakázky <strong>{info.title}</strong> byl platný 7 dní a jeho platnost již vypršela.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Požádejte dodavatele o zaslání nového odkazu.
            </p>
          </div>
        )}

        {!loading && done && (
          <div className="mt-8 rounded-xl border border-green-200 bg-green-50 p-6 text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
            <p className="text-lg font-semibold text-green-800">Podpis byl úspěšně přijat</p>
            {info && (
              <p className="text-sm text-muted-foreground">
                Zakázka: <strong>{info.title}</strong>
              </p>
            )}
            {signedAt && (
              <p className="text-xs text-muted-foreground">
                Podepsáno: {new Date(signedAt).toLocaleString("cs-CZ")}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Tuto stránku můžete zavřít.
            </p>
          </div>
        )}

        {!loading && info && !done && !info.expired && !error && (
          <div className="space-y-6 mt-4">
            <div className="rounded-xl border bg-white p-4 shadow-sm space-y-2">
              <h2 className="font-semibold text-base">Shrnutí zakázky</h2>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Název</span>
                <span className="font-medium">{info.title}</span>
                {info.customerCompanyName && (
                  <>
                    <span className="text-muted-foreground">Zákazník</span>
                    <span className="font-medium">{info.customerCompanyName}</span>
                  </>
                )}
                <span className="text-muted-foreground">Datum</span>
                <span>{info.date}</span>
              </div>
              {info.notes && (
                <div className="mt-2 pt-2 border-t text-sm">
                  <p className="text-muted-foreground text-xs mb-1">Popis</p>
                  <p className="whitespace-pre-wrap">{info.notes}</p>
                </div>
              )}
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm space-y-3">
              <h2 className="font-semibold text-base flex items-center gap-2">
                <PenLine className="h-4 w-4 text-blue-600" />
                Váš podpis
              </h2>
              <p className="text-xs text-muted-foreground">
                Nakreslete podpis prstem nebo myší do pole níže. Podpisem potvrzujete převzetí a souhlas s výše uvedenými údaji.
              </p>
              <SignatureCanvas onCapture={setSignatureDataUrl} />
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Podepsáním tohoto formuláře potvrzuji, že jsem byl/a seznámen/a s předávacím protokolem výše uvedené zakázky a souhlasím s jeho obsahem.
            </div>

            <Button
              className="w-full h-12 text-base"
              disabled={!signatureDataUrl || submitting}
              onClick={handleSign}
            >
              {submitting ? "Odesílám…" : "Podepsat a potvrdit"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
