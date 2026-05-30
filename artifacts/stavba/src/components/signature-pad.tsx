import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Eraser, Check } from "lucide-react";

interface SignaturePadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (dataUrl: string) => void;
  title?: string;
}

export function SignaturePad({ open, onOpenChange, onSave, title = "Podpis" }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  // Set up canvas backing resolution once it is visible
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#1e3a8a";
      }
      setHasInk(false);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk) setHasInk(true);
  };

  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setHasInk(false);
    }
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    onSave(canvas.toDataURL("image/png"));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">Podepište se prstem nebo myší do pole níže.</p>
        <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-white">
          <canvas
            ref={canvasRef}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
            className="w-full h-48 touch-none rounded-lg"
            style={{ touchAction: "none" }}
          />
        </div>
        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={clear} disabled={!hasInk}>
            <Eraser className="w-4 h-4 mr-2" /> Vymazat
          </Button>
          <Button type="button" onClick={save} disabled={!hasInk}>
            <Check className="w-4 h-4 mr-2" /> Hotovo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
