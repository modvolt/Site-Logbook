import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyPpeAssignments,
  useSignMyPpeHandover,
  getListMyPpeAssignmentsQueryKey,
  type MyPpeAssignment,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
  PenLine,
  Clock,
  Package,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { invalidateData } from "@/lib/query-invalidation";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function initCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 480;
  const h = rect.height || 160;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1e3a8a";
}

function SignaturePad({ onSignature }: { onSignature: (dataUrl: string | null) => void }) {
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const callbackRef = useRef<HTMLCanvasElement | null>(null);
  const setCanvasRef = (el: HTMLCanvasElement | null) => {
    callbackRef.current = el;
    if (el) initCanvas(el);
  };

  const getPos = (clientX: number, clientY: number, target: HTMLCanvasElement) => {
    const rect = target.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const draw = (x: number, y: number) => {
    const canvas = callbackRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !lastRef.current) return;
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastRef.current = { x, y };
    setHasInk(true);
    onSignature(canvas!.toDataURL("image/png"));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
    drawingRef.current = true;
    const p = getPos(e.clientX, e.clientY, e.currentTarget);
    lastRef.current = p;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    draw(
      e.clientX - e.currentTarget.getBoundingClientRect().left,
      e.clientY - e.currentTarget.getBoundingClientRect().top,
    );
  };
  const onPointerEnd = () => { drawingRef.current = false; lastRef.current = null; };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    lastRef.current = getPos(e.clientX, e.clientY, e.currentTarget);
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || e.buttons === 0) return;
    draw(
      e.clientX - e.currentTarget.getBoundingClientRect().left,
      e.clientY - e.currentTarget.getBoundingClientRect().top,
    );
  };
  const onMouseUp = () => { drawingRef.current = false; lastRef.current = null; };

  const clear = () => {
    const canvas = callbackRef.current;
    if (!canvas) return;
    initCanvas(canvas);
    setHasInk(false);
    onSignature(null);
  };

  return (
    <div>
      <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-white overflow-hidden relative">
        <canvas
          ref={setCanvasRef}
          data-testid="signature-canvas"
          className="w-full touch-none"
          style={{ height: "160px", display: "block", touchAction: "none", cursor: "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerLeave={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
        {!hasInk && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-muted-foreground select-none">Podepište se prstem nebo myší</span>
          </div>
        )}
      </div>
      <div className="flex justify-end mt-1">
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!hasInk} className="h-7 text-xs text-muted-foreground">
          Smazat podpis
        </Button>
      </div>
    </div>
  );
}

function AssignmentCard({
  assignment,
  onSigned,
}: {
  assignment: MyPpeAssignment;
  onSigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const sign = useSignMyPpeHandover();

  const handleSign = () => {
    if (!signatureDataUrl) return;
    sign.mutate(
      { id: assignment.id, data: { signatureDataUrl } },
      {
        onSuccess: () => {
          setDone(true);
          toast({ title: "Podpis byl přijat", description: `Protokol k ${assignment.ppeNameSnapshot} byl vytvořen.` });
          invalidateData(qc, "ppe");
          setTimeout(onSigned, 1200);
        },
        onError: (err) => {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
            ?? "Nepodařilo se odeslat podpis. Zkuste to znovu.";
          toast({ title: "Chyba při podepisování", description: msg, variant: "destructive" });
        },
      },
    );
  };

  if (done) {
    return (
      <Card className="border-green-200 bg-green-50/60">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
          <div>
            <p className="font-medium text-sm text-green-800">{assignment.ppeNameSnapshot}</p>
            <p className="text-xs text-green-700">Podpis byl přijat</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{assignment.ppeNameSnapshot}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {assignment.ppeCategorySnapshot && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {assignment.ppeCategorySnapshot}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Package className="h-3 w-3" /> {assignment.quantity} ks
              </span>
              {assignment.size && (
                <span className="text-xs text-muted-foreground">vel. {assignment.size}</span>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant={open ? "outline" : "default"}
            className="shrink-0"
            onClick={() => setOpen((v) => !v)}
          >
            <PenLine className="h-3.5 w-3.5 mr-1" />
            {open ? "Zavřít" : "Podepsat"}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span>Datum výdeje:</span>
          <span className="text-foreground font-medium">{fmtDate(assignment.issuedAt)}</span>
          {assignment.replaceBy && (
            <>
              <span>Výměna do:</span>
              <span className="text-foreground font-medium flex items-center gap-1">
                <Clock className="h-3 w-3" /> {fmtDate(assignment.replaceBy)}
              </span>
            </>
          )}
          {assignment.serialNumber && (
            <>
              <span>Sériové číslo:</span>
              <span className="text-foreground font-medium">{assignment.serialNumber}</span>
            </>
          )}
        </div>

        {open && (
          <div className="pt-2 border-t space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
              Podpisem potvrzuji, že jsem převzal/a výše uvedené OOPP a budu je řádně používat v souladu s pokyny zaměstnavatele.
            </div>
            <SignaturePad onSignature={setSignatureDataUrl} />
            <Button
              className="w-full"
              disabled={!signatureDataUrl || sign.isPending}
              onClick={handleSign}
            >
              {sign.isPending ? "Odesílám…" : "Potvrdit převzetí a podepsat"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function OoppMoje() {
  const { data, isLoading } = useListMyPpeAssignments();
  const qc = useQueryClient();

  const refetch = () => {
    void qc.invalidateQueries({ queryKey: getListMyPpeAssignmentsQueryKey() });
  };

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/me">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            Moje OOPP k podpisu
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Podepište převzetí přidělených ochranných pomůcek
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      )}

      {!isLoading && data && data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-3" />
            <p className="font-semibold">Vše podepsáno</p>
            <p className="text-sm text-muted-foreground mt-1">
              Nemáte žádné nevyřízené výdeje OOPP čekající na podpis.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((assignment) => (
            <AssignmentCard key={assignment.id} assignment={assignment} onSigned={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}
