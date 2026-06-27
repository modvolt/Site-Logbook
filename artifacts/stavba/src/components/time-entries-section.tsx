import { useState, useEffect } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DecimalInput, decimalError, parseDecimal } from "@/components/decimal-input";
import { Users, Clock, Play, Square, Plus, Trash2, Check, X, Pencil } from "lucide-react";

export type TimeEntryItem = {
  id: number;
  personId: number;
  personName: string;
  hours: number;
  timerStartedAt?: string | null;
};

export type PersonOption = { id: number; name: string };

function elapsedSeconds(startedAt: string | null | undefined, now: number): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

function fmtElapsed(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function fmtH(n: number): string {
  return `${Math.round(n * 100) / 100} h`;
}

interface Props {
  entries: TimeEntryItem[];
  people: PersonOption[];
  canWrite: boolean;
  onStart: (personId: number) => void;
  onStop: (personId: number) => void;
  onSetHours: (personId: number, hours: number) => void;
  onAddPerson: (personId: number) => void;
  onRemove: (personId: number) => void;
  busy?: boolean;
}

export function TimeEntriesSection({
  entries, people, canWrite, onStart, onStop, onSetHours, onAddPerson, onRemove, busy,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const { openConfirm, dialogProps } = useConfirmDialog();
  const [newPersonId, setNewPersonId] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const anyRunning = entries.some((e) => e.timerStartedAt);
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  const liveTotal = entries.reduce(
    (sum, e) => sum + e.hours + elapsedSeconds(e.timerStartedAt, now) / 3600,
    0,
  );

  const availablePeople = people.filter((p) => !entries.some((e) => e.personId === p.id));

  const handleAdd = () => {
    if (!newPersonId) return;
    onAddPerson(Number(newPersonId));
    setNewPersonId("");
    setAdding(false);
  };

  const startEdit = (e: TimeEntryItem) => {
    setEditId(e.personId);
    setEditValue(String(e.hours));
  };

  const saveEdit = (personId: number) => {
    const v = parseDecimal(editValue);
    if (v === null || v < 0) { setEditId(null); return; }
    onSetHours(personId, Math.round(v * 100) / 100);
    setEditId(null);
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-500" /> Čas zaměstnanců
            {liveTotal > 0 && (
              <span className="text-sm font-normal text-muted-foreground">· celkem {fmtH(liveTotal)}</span>
            )}
          </h2>
          {canWrite && !adding && availablePeople.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4 mr-1" /> Zaměstnanec
            </Button>
          )}
        </div>

        {adding && canWrite && (
          <div className="flex gap-2 p-3 border rounded-md bg-muted/30">
            <select
              className="flex-1 h-10 rounded-md border bg-background px-3 text-sm"
              value={newPersonId}
              onChange={(e) => setNewPersonId(e.target.value)}
              autoFocus
            >
              <option value="">— Vyberte zaměstnance —</option>
              {availablePeople.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <Button size="sm" onClick={handleAdd} disabled={!newPersonId || busy}>Přidat</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewPersonId(""); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            Zatím není evidován čas žádného zaměstnance.
          </p>
        ) : (
          <ul className="space-y-1">
            {entries.map((e) => {
              const running = !!e.timerStartedAt;
              const live = e.hours + elapsedSeconds(e.timerStartedAt, now) / 3600;
              const isEditing = editId === e.personId;
              return (
                <li
                  key={e.id}
                  className={`flex items-center gap-2 py-2 border-b last:border-0 ${running ? "bg-emerald-50/60 dark:bg-emerald-900/10 rounded-md px-2" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{e.personName}</div>
                    {isEditing ? (
                      <div className="flex items-center gap-1 mt-1">
                        <DecimalInput
                          value={editValue}
                          onChange={(v) => setEditValue(v)}
                          className="h-8 w-24"
                          autoFocus
                          error={decimalError(editValue)}
                        />
                        <span className="text-xs text-muted-foreground">h</span>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => saveEdit(e.personId)}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditId(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Clock className="h-3 w-3" /> {fmtH(running ? live : e.hours)}
                        {running && (
                          <span className="text-emerald-600 dark:text-emerald-400 font-mono">
                            · běží {fmtElapsed(elapsedSeconds(e.timerStartedAt, now))}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {canWrite && !isEditing && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => (running ? onStop(e.personId) : onStart(e.personId))}
                        className={running ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-500 hover:bg-emerald-600"}
                        disabled={busy}
                      >
                        {running ? <><Square className="h-4 w-4 mr-1 fill-white" /> Stop</> : <><Play className="h-4 w-4 mr-1 fill-white" /> Start</>}
                      </Button>
                      {!running && (
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(e)} title="Upravit hodiny">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-rose-500"
                        onClick={() => openConfirm(`Odebrat ${e.personName} z evidence času?`, () => onRemove(e.personId))}
                        title="Odebrat"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog {...dialogProps} />
    </Card>
  );
}
