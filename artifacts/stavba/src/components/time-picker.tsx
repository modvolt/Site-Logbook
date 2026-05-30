import { useState, useRef, useEffect, useCallback } from "react";
import { Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Mode = "hour" | "minute";

const SIZE = 280;
const C = SIZE / 2;
const R_OUT = 116;
const R_IN = 74;
const RING_SPLIT = (R_OUT + R_IN) / 2;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseValue(v: string | null | undefined): { h: number; m: number } | null {
  if (!v) return null;
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(v.trim());
  if (!match) return null;
  const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return { h, m };
}

// Position of a clock index on a ring. idx 0 = top (12 o'clock), going clockwise.
function polar(idx: number, total: number, radius: number) {
  const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
  return { x: C + radius * Math.cos(angle), y: C + radius * Math.sin(angle) };
}

function hourPlacement(h: number): { idx: number; inner: boolean } {
  if (h === 0) return { idx: 0, inner: true };
  if (h === 12) return { idx: 0, inner: false };
  if (h < 12) return { idx: h, inner: false };
  return { idx: h - 12, inner: true };
}

export interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function TimePicker({ value, onChange, placeholder = "--:--", className = "", id }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseValue(value);
  const [h, setH] = useState(parsed?.h ?? 8);
  const [m, setM] = useState(parsed?.m ?? 0);
  const [mode, setMode] = useState<Mode>("hour");
  const dialRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const openPicker = () => {
    const p = parseValue(value);
    setH(p?.h ?? 8);
    setM(p?.m ?? 0);
    setMode("hour");
    setOpen(true);
  };

  const commit = (nh: number, nm: number) => onChange(`${pad(nh)}:${pad(nm)}`);

  const applyFromPoint = useCallback((clientX: number, clientY: number, currentMode: Mode) => {
    const el = dialRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const dx = px - C;
    const dy = py - C;
    let ang = Math.atan2(dx, -dy) * (180 / Math.PI);
    if (ang < 0) ang += 360;
    const dist = Math.hypot(dx, dy);

    if (currentMode === "hour") {
      const idx = Math.round(ang / 30) % 12;
      const inner = dist < RING_SPLIT;
      let nh: number;
      if (inner) nh = idx === 0 ? 0 : idx + 12;
      else nh = idx === 0 ? 12 : idx;
      setH(nh);
    } else {
      const nm = Math.round(ang / 6) % 60;
      setM(nm);
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    applyFromPoint(e.clientX, e.clientY, mode);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    applyFromPoint(e.clientX, e.clientY, mode);
  };

  const handlePointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (mode === "hour") setMode("minute");
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Hand target
  const handTarget = mode === "hour"
    ? (() => {
        const { idx, inner } = hourPlacement(h);
        return polar(idx, 12, inner ? R_IN : R_OUT);
      })()
    : polar(m, 60, R_OUT);

  const outerHours = Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i));
  const innerHours = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : i + 12));
  const minuteMarks = Array.from({ length: 12 }, (_, i) => i * 5);

  return (
    <>
      <button
        type="button"
        id={id}
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left ${className}`}
      >
        <span className={value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Výběr času" className="relative bg-card rounded-2xl shadow-2xl w-full max-w-[340px] overflow-hidden">
            {/* Digital header */}
            <div className="bg-primary/10 px-6 py-5 flex items-center justify-center gap-1">
              <button
                type="button"
                onClick={() => setMode("hour")}
                className={`text-5xl font-light tabular-nums transition-colors ${mode === "hour" ? "text-primary" : "text-foreground/70"}`}
              >
                {pad(h)}
              </button>
              <span className="text-5xl font-light text-foreground/70">:</span>
              <button
                type="button"
                onClick={() => setMode("minute")}
                className={`text-5xl font-light tabular-nums transition-colors ${mode === "minute" ? "text-primary" : "text-foreground/70"}`}
              >
                {pad(m)}
              </button>
            </div>

            {/* Clock face */}
            <div className="flex justify-center py-6">
              <div
                ref={dialRef}
                className="relative rounded-full bg-muted touch-none select-none"
                style={{ width: SIZE, height: SIZE }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                {/* center dot */}
                <div className="absolute w-2 h-2 rounded-full bg-primary" style={{ left: C - 4, top: C - 4 }} />
                {/* hand */}
                <svg className="absolute inset-0 pointer-events-none" width={SIZE} height={SIZE}>
                  <line x1={C} y1={C} x2={handTarget.x} y2={handTarget.y} stroke="hsl(var(--primary))" strokeWidth={2} />
                  <circle cx={handTarget.x} cy={handTarget.y} r={20} fill="hsl(var(--primary))" opacity={0.25} />
                </svg>

                {mode === "hour" ? (
                  <>
                    {outerHours.map((val, i) => {
                      const pos = polar(i, 12, R_OUT);
                      const active = h === val;
                      return (
                        <span
                          key={`o${val}`}
                          className={`absolute flex items-center justify-center rounded-full text-sm font-medium pointer-events-none ${active ? "text-primary font-bold" : "text-foreground"}`}
                          style={{ left: pos.x - 16, top: pos.y - 16, width: 32, height: 32 }}
                        >
                          {pad(val)}
                        </span>
                      );
                    })}
                    {innerHours.map((val, i) => {
                      const pos = polar(i, 12, R_IN);
                      const active = h === val;
                      return (
                        <span
                          key={`i${val}`}
                          className={`absolute flex items-center justify-center rounded-full text-xs pointer-events-none ${active ? "text-primary font-bold" : "text-muted-foreground"}`}
                          style={{ left: pos.x - 14, top: pos.y - 14, width: 28, height: 28 }}
                        >
                          {pad(val)}
                        </span>
                      );
                    })}
                  </>
                ) : (
                  minuteMarks.map((val, i) => {
                    const pos = polar(i, 12, R_OUT);
                    const active = m === val;
                    return (
                      <span
                        key={`m${val}`}
                        className={`absolute flex items-center justify-center rounded-full text-sm font-medium pointer-events-none ${active ? "text-primary font-bold" : "text-foreground"}`}
                        style={{ left: pos.x - 16, top: pos.y - 16, width: 32, height: 32 }}
                      >
                        {pad(val)}
                      </span>
                    );
                  })
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between px-4 pb-4 gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(""); setOpen(false); }} className="text-muted-foreground">
                <X className="h-4 w-4 mr-1" /> Vymazat
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Zrušit</Button>
                <Button type="button" onClick={() => { commit(h, m); setOpen(false); }}>Hotovo</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
