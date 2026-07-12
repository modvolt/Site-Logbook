export type ReviewField = { fieldKey: string; validationStatus: string; confidence: number; manuallyCorrected: boolean; normalizedValue: string | null; correctedValue: string | null; rawValue?: string | null };
export type RequiredDefinition = { fieldKey: string; minimumConfidence: number };

export function effectiveReviewValue(field: ReviewField): string | null {
  return field.manuallyCorrected ? field.correctedValue : field.normalizedValue;
}

export function extractionIsComplete(fields: ReviewField[], required: RequiredDefinition[]): boolean {
  return required.every((definition) => fields.some((field) => field.fieldKey === definition.fieldKey && field.validationStatus === "valid" && Boolean(effectiveReviewValue(field)) && (field.manuallyCorrected || field.confidence >= definition.minimumConfidence)));
}

export function compareExtractionVersions(before: ReviewField[], after: ReviewField[]) {
  const keys = [...new Set([...before, ...after].map((field) => field.fieldKey))].sort();
  const find = (rows: ReviewField[], key: string) => rows.find((field) => field.fieldKey === key) ?? null;
  return keys.map((fieldKey) => {
    const oldField = find(before, fieldKey); const newField = find(after, fieldKey);
    return { fieldKey, before: oldField ? effectiveReviewValue(oldField) : null, after: newField ? effectiveReviewValue(newField) : null };
  }).filter((change) => change.before !== change.after);
}
