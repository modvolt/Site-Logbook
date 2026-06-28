import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { ShieldCheck, CheckCircle2, PenLine, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AssignmentInfo {
  id: number;
  ppeNameSnapshot: string;
  personNameSnapshot: string;
  quantity: number;
  size: string | null;
  serialNumber: string | null;
  issuedAt: string;
  status: string;
  alreadySigned: boolean;
  employeeConfirmedAt: string | null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
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

export default function OoppSign() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [info, setInfo] = useState<AssignmentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/ppe/sign/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setInfo(data);
          if (data.alreadySigned) setDone(true);
        }
      })
      .catch(() => setError("Nepodařilo se načíst informace o výdeji"))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSign() {
    if (!signatureDataUrl || !token) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/ppe/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Nepodařilo se odeslat podpis");
        return;
      }
      setDone(true);
      setInfo((prev) => prev ? { ...prev, alreadySigned: true, employeeConfirmedAt: data.employeeConfirmedAt } : prev);
    } catch {
      setError("Nepodařilo se odeslat podpis. Zkuste to prosím znovu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-blue-50 to-white flex flex-col">
      <div className="bg-white border-b px-4 py-3 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-blue-700" />
        <span className="font-semibold text-sm text-blue-900">Potvrzení převzetí OOPP</span>
      </div>

      <div className="flex-1 p-4 max-w-lg mx-auto w-full">
        {loading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
            Načítám…
          </div>
        )}

        {!loading && error && !done && (
          <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-base font-semibold text-destructive mb-1">Odkaz není platný</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        )}

        {!loading && info && done && (
          <div className="mt-8 rounded-xl border border-green-200 bg-green-50 p-6 text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
            <p className="text-lg font-semibold text-green-800">Podpis byl přijat</p>
            <p className="text-sm text-muted-foreground">
              Potvrzujete převzetí: <strong>{info.ppeNameSnapshot}</strong>
            </p>
            {info.employeeConfirmedAt && (
              <p className="text-xs text-muted-foreground">
                Potvrzeno: {new Date(info.employeeConfirmedAt).toLocaleString("cs-CZ")}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Tuto stránku můžete zavřít.
            </p>
          </div>
        )}

        {!loading && info && !done && (
          <div className="space-y-6 mt-4">
            <div className="rounded-xl border bg-white p-4 shadow-sm space-y-2">
              <h2 className="font-semibold text-base">Předmět výdeje</h2>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Zaměstnanec</span>
                <span className="font-medium">{info.personNameSnapshot}</span>
                <span className="text-muted-foreground">Pomůcka</span>
                <span className="font-medium">{info.ppeNameSnapshot}</span>
                <span className="text-muted-foreground">Počet</span>
                <span>{info.quantity}</span>
                {info.size && (
                  <>
                    <span className="text-muted-foreground">Velikost</span>
                    <span>{info.size}</span>
                  </>
                )}
                {info.serialNumber && (
                  <>
                    <span className="text-muted-foreground">Sériové číslo</span>
                    <span>{info.serialNumber}</span>
                  </>
                )}
                <span className="text-muted-foreground">Datum výdeje</span>
                <span>{fmtDate(info.issuedAt)}</span>
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm space-y-3">
              <h2 className="font-semibold text-base flex items-center gap-2">
                <PenLine className="h-4 w-4 text-blue-600" />
                Váš podpis
              </h2>
              <p className="text-xs text-muted-foreground">
                Nakreslete podpis prstem nebo myší do pole níže. Podpisem potvrzujete, že jste výše uvedené OOPP převzali.
              </p>
              <SignatureCanvas onCapture={setSignatureDataUrl} />
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Podepsáním tohoto formuláře potvrzuji, že jsem obdržel/a výše uvedené osobní ochranné pracovní prostředky
              a budu je řádně používat a udržovat v souladu s pokyny zaměstnavatele.
            </div>

            <Button
              className="w-full h-12 text-base"
              disabled={!signatureDataUrl || submitting}
              onClick={handleSign}
            >
              {submitting ? "Odesílám…" : "Potvrdit převzetí a podepsat"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
