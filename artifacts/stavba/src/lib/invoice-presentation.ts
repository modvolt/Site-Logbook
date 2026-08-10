import type {
  InvoiceLine,
  InvoicePresentationGroup,
} from "@workspace/api-client-react";

type PresentationSourceLine = Pick<
  InvoiceLine,
  "description" | "totalWithoutVat" | "vatMode" | "vatRate"
>;

export function createDefaultPresentationGroups(
  lines: readonly PresentationSourceLine[],
): InvoicePresentationGroup[] {
  return lines.map((line, index) => ({
    description: line.description,
    lineIndexes: [index],
  }));
}

export function initializePresentationGroups(
  lines: readonly PresentationSourceLine[],
  stored: readonly InvoicePresentationGroup[],
): InvoicePresentationGroup[] {
  const groups = stored.map((group) => ({
    description: group.description,
    lineIndexes: [...group.lineIndexes],
  }));
  return validatePresentationGroups(groups, lines) === null
    ? groups
    : createDefaultPresentationGroups(lines);
}

function taxKey(line: PresentationSourceLine): string {
  return `${line.vatMode}:${line.vatRate ?? "null"}`;
}

export function validatePresentationGroups(
  groups: readonly InvoicePresentationGroup[],
  lines: readonly PresentationSourceLine[],
): string | null {
  if (lines.length === 0) {
    return "Vlastní texty vyžadují alespoň jednu zdrojovou položku.";
  }
  if (groups.length === 0) {
    return "Faktura musí obsahovat alespoň jeden zákaznický řádek.";
  }

  const seen = new Set<number>();
  for (const group of groups) {
    const description = group.description.trim();
    if (!description) return "Každý zákaznický řádek musí mít vlastní text.";
    if (description.length > 500) {
      return "Text zákaznického řádku může mít nejvýše 500 znaků.";
    }
    if (group.lineIndexes.length === 0) {
      return "Každý zákaznický řádek musí obsahovat alespoň jeden interní zdroj.";
    }

    const firstIndex = group.lineIndexes[0];
    if (
      !Number.isInteger(firstIndex) ||
      firstIndex < 0 ||
      firstIndex >= lines.length
    ) {
      return "Zákaznický řádek odkazuje na neplatný interní zdroj.";
    }
    const firstTaxKey = taxKey(lines[firstIndex]);
    for (const index of group.lineIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
        return "Zákaznický řádek odkazuje na neplatný interní zdroj.";
      }
      if (seen.has(index)) {
        return "Jeden interní zdroj nelze použít ve více zákaznických řádcích.";
      }
      if (taxKey(lines[index]) !== firstTaxKey) {
        return "Sloučit lze pouze položky se stejným režimem a sazbou DPH.";
      }
      seen.add(index);
    }
  }

  return seen.size === lines.length
    ? null
    : "Každý interní zdroj musí zůstat zahrnutý ve faktuře.";
}

export function mergePresentationGroups(
  groups: readonly InvoicePresentationGroup[],
  selectedIndexes: readonly number[],
  lines: readonly PresentationSourceLine[],
): { groups: InvoicePresentationGroup[]; error: string | null } {
  const selected = [...new Set(selectedIndexes)].sort((a, b) => a - b);
  if (selected.length < 2) {
    return {
      groups: groups.map(cloneGroup),
      error: "Vyberte alespoň dva zákaznické řádky ke sloučení.",
    };
  }
  if (selected.some((index) => index < 0 || index >= groups.length)) {
    return {
      groups: groups.map(cloneGroup),
      error: "Vybrané řádky už nejsou dostupné. Zkuste je vybrat znovu.",
    };
  }

  const mergedLineIndexes = selected.flatMap(
    (index) => groups[index].lineIndexes,
  );
  const taxKeys = new Set(
    mergedLineIndexes.map((lineIndex) => taxKey(lines[lineIndex])),
  );
  if (taxKeys.size !== 1) {
    return {
      groups: groups.map(cloneGroup),
      error: "Sloučit lze pouze položky se stejným režimem a sazbou DPH.",
    };
  }

  const selectedSet = new Set(selected);
  const first = selected[0];
  const next: InvoicePresentationGroup[] = [];
  groups.forEach((group, index) => {
    if (index === first) {
      next.push({
        description: groups[first].description,
        lineIndexes: mergedLineIndexes,
      });
    } else if (!selectedSet.has(index)) {
      next.push(cloneGroup(group));
    }
  });
  return { groups: next, error: null };
}

export function splitPresentationGroup(
  groups: readonly InvoicePresentationGroup[],
  groupIndex: number,
  lines: readonly PresentationSourceLine[],
): InvoicePresentationGroup[] {
  const group = groups[groupIndex];
  if (!group || group.lineIndexes.length < 2) return groups.map(cloneGroup);

  return groups.flatMap((candidate, index) =>
    index === groupIndex
      ? candidate.lineIndexes.map((lineIndex) => ({
          description: lines[lineIndex].description,
          lineIndexes: [lineIndex],
        }))
      : [cloneGroup(candidate)],
  );
}

export function movePresentationGroup(
  groups: readonly InvoicePresentationGroup[],
  from: number,
  to: number,
): InvoicePresentationGroup[] {
  const next = groups.map(cloneGroup);
  if (
    from < 0 ||
    to < 0 ||
    from >= next.length ||
    to >= next.length ||
    from === to
  ) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function presentationGroupTotal(
  group: InvoicePresentationGroup,
  lines: readonly PresentationSourceLine[],
): number {
  return group.lineIndexes.reduce(
    (sum, index) => sum + Number(lines[index]?.totalWithoutVat ?? 0),
    0,
  );
}

function cloneGroup(group: InvoicePresentationGroup): InvoicePresentationGroup {
  return {
    description: group.description,
    lineIndexes: [...group.lineIndexes],
  };
}
