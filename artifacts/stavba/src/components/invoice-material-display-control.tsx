import { List, Package } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type MaterialDisplayMode = "detailed" | "summary";

export function InvoiceMaterialDisplayControl({
  value,
  onChange,
  className,
}: {
  value: MaterialDisplayMode;
  onChange: (value: MaterialDisplayMode) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div>
        <div className="text-sm font-semibold">
          Jak zobrazit materiál na faktuře?
        </div>
      </div>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (next === "detailed" || next === "summary") onChange(next);
        }}
        variant="outline"
        className="rounded-md border bg-background p-1"
        aria-label="Jak zobrazit materiál na faktuře?"
      >
        <ToggleGroupItem
          value="detailed"
          className="h-9 px-3"
          aria-label="Po položkách"
          title="Zobrazit jednotlivé položky"
        >
          <List className="h-4 w-4" />
          <span>Po položkách</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="summary"
          className="h-9 px-3"
          aria-label="Jednou částkou"
          title="Zobrazit materiál jako jednu částku"
        >
          <Package className="h-4 w-4" />
          <span>Jednou částkou</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
