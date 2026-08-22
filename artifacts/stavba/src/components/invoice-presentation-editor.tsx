import { useState } from "react";
import type {
  InvoiceDetail,
  InvoicePresentationGroup,
} from "@workspace/api-client-react";
import {
  ArrowDown,
  ArrowUp,
  Combine,
  List,
  Package,
  PencilLine,
  Split,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtKc } from "@/lib/billing-format";
import {
  mergePresentationGroups,
  movePresentationGroup,
  presentationGroupTotal,
  splitPresentationGroup,
} from "@/lib/invoice-presentation";

export type InvoicePresentationMode = InvoiceDetail["materialDisplayMode"];

export type InvoicePresentationSourceLine = Pick<
  InvoiceDetail["lines"][number],
  "description" | "totalWithoutVat" | "vatMode" | "vatRate"
>;

export function InvoicePresentationModeControl({
  value,
  hasMaterial,
  onChange,
}: {
  value: InvoicePresentationMode;
  hasMaterial: boolean;
  onChange: (value: InvoicePresentationMode) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold">
          Podoba faktury pro zákazníka
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Zdrojové položky zůstávají interně propojené se zakázkami a skladem.
          Měníte pouze text a seskupení zobrazené na faktuře a v PDF.
        </p>
      </div>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (next === "detailed" || next === "summary" || next === "custom") {
            onChange(next);
          }
        }}
        variant="outline"
        className="grid w-full grid-cols-1 gap-2 rounded-lg border bg-background p-1 sm:grid-cols-3"
        aria-label="Podoba faktury pro zákazníka"
      >
        <ToggleGroupItem value="detailed" className="h-10 gap-2 px-3">
          <List className="h-4 w-4" />
          <span>Podle zdrojů</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="summary"
          disabled={!hasMaterial}
          className="h-10 gap-2 px-3"
          title={hasMaterial ? undefined : "Faktura neobsahuje materiál"}
        >
          <Package className="h-4 w-4" />
          <span>Materiál souhrnně</span>
        </ToggleGroupItem>
        <ToggleGroupItem value="custom" className="h-10 gap-2 px-3">
          <PencilLine className="h-4 w-4" />
          <span>Vlastní texty</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function InvoiceCustomPresentationEditor({
  lines,
  groups,
  onChange,
}: {
  lines: readonly InvoicePresentationSourceLine[];
  groups: readonly InvoicePresentationGroup[];
  onChange: (groups: InvoicePresentationGroup[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const sourceCountLabel = (count: number) => {
    if (count === 1) return "1 interní zdroj";
    if (count >= 2 && count <= 4) return `${count} interní zdroje`;
    return `${count} interních zdrojů`;
  };

  const toggleSelected = (index: number, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  const mergeSelected = () => {
    const result = mergePresentationGroups(groups, [...selected], lines);
    if (result.error) {
      setActionError(result.error);
      return;
    }
    setActionError(null);
    setSelected(new Set());
    onChange(result.groups);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Zákaznické řádky</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Vyberte více řádků se stejnou DPH, slučte je a napište výsledný
            text.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={mergeSelected}
          disabled={selected.size < 2}
          className="h-9"
        >
          <Combine className="mr-2 h-4 w-4" />
          Sloučit vybrané
        </Button>
      </div>

      {actionError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </p>
      )}

      <div className="divide-y rounded-lg border">
        {groups.map((group, groupIndex) => (
          <section key={group.lineIndexes.join("-")} className="space-y-3 p-3">
            <div className="flex items-center gap-3">
              <Checkbox
                id={`presentation-group-${groupIndex}`}
                checked={selected.has(groupIndex)}
                onCheckedChange={(checked) =>
                  toggleSelected(groupIndex, checked === true)
                }
                aria-label={`Vybrat zákaznický řádek ${groupIndex + 1}`}
              />
              <label
                htmlFor={`presentation-group-${groupIndex}`}
                className="min-w-0 flex-1 text-sm font-medium"
              >
                Řádek {groupIndex + 1}
                <span className="ml-2 font-normal text-muted-foreground">
                  {sourceCountLabel(group.lineIndexes.length)}
                </span>
              </label>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {fmtKc(presentationGroupTotal(group, lines))}
              </span>
            </div>

            <Textarea
              value={group.description}
              onChange={(event) => {
                setActionError(null);
                onChange(
                  groups.map((candidate, index) =>
                    index === groupIndex
                      ? { ...candidate, description: event.target.value }
                      : {
                          ...candidate,
                          lineIndexes: [...candidate.lineIndexes],
                        },
                  ),
                );
              }}
              maxLength={500}
              rows={2}
              className="min-h-16 resize-y text-base md:text-sm"
              aria-label={`Text zákaznického řádku ${groupIndex + 1}`}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium text-foreground">
                  Zobrazit interní zdroje
                </summary>
                <ul className="mt-2 space-y-1 pl-5">
                  {group.lineIndexes.map((lineIndex) => (
                    <li key={lineIndex} className="list-disc break-words">
                      {lines[lineIndex]?.description ?? "Neznámý zdroj"} ·{" "}
                      {fmtKc(lines[lineIndex]?.totalWithoutVat ?? 0)}
                    </li>
                  ))}
                </ul>
              </details>

              <div className="flex items-center gap-1">
                {group.lineIndexes.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onChange(
                        splitPresentationGroup(groups, groupIndex, lines),
                      );
                      setSelected(new Set());
                      setActionError(null);
                    }}
                    className="h-8 px-2"
                  >
                    <Split className="mr-1.5 h-3.5 w-3.5" />
                    Rozdělit
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    onChange(
                      movePresentationGroup(groups, groupIndex, groupIndex - 1),
                    );
                    setSelected(new Set());
                  }}
                  disabled={groupIndex === 0}
                  className="h-8 w-8"
                  aria-label={`Posunout řádek ${groupIndex + 1} nahoru`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    onChange(
                      movePresentationGroup(groups, groupIndex, groupIndex + 1),
                    );
                    setSelected(new Set());
                  }}
                  disabled={groupIndex === groups.length - 1}
                  className="h-8 w-8"
                  aria-label={`Posunout řádek ${groupIndex + 1} dolů`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
