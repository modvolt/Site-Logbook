import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

type AutocompleteProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: string[];
  maxItems?: number;
};

export function Autocomplete({
  value,
  onValueChange,
  suggestions,
  maxItems = 8,
  onKeyDown,
  onFocus,
  className,
  ...inputProps
}: AutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  const filtered: string[] = [];
  const seen = new Set<string>();
  for (const raw of suggestions) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const low = name.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    if (q && low === q) continue;
    if (q && !low.includes(q)) continue;
    filtered.push(name);
    if (filtered.length >= maxItems) break;
  }

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHighlight(-1);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
    };
  }, [open]);

  const showList = open && filtered.length > 0;

  const choose = (s: string) => {
    onValueChange(s);
    setOpen(false);
    setHighlight(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showList) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight(h => (h + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight(h => (h <= 0 ? filtered.length - 1 : h - 1));
        return;
      }
      if (e.key === "Enter" && highlight >= 0) {
        e.preventDefault();
        choose(filtered[highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div ref={containerRef} className="relative">
      <Input
        {...inputProps}
        className={className}
        value={value}
        onChange={e => { onValueChange(e.target.value); setOpen(true); setHighlight(-1); }}
        onFocus={e => { setOpen(true); onFocus?.(e); }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
      />
      {showList && (
        <div className="absolute top-full left-0 right-0 z-50 bg-card border rounded-lg shadow-xl mt-1 max-h-48 overflow-y-auto">
          {filtered.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`w-full text-left px-3 py-2.5 text-sm hover:bg-muted transition-colors border-b last:border-b-0 ${i === highlight ? "bg-muted" : ""}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => choose(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
