const FORMULA_PREFIX_AFTER_CONTROL = /^[\u0000-\u0020]*[=+\-@]/;

/** Neutralize spreadsheet formulas while preserving actual numeric cells. */
export function neutralizeSpreadsheetFormula(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (typeof value !== "string") return text;
  return FORMULA_PREFIX_AFTER_CONTROL.test(text) ? `'${text}` : text;
}

export function encodeCsvCell(
  value: unknown,
  options: { delimiter?: string; alwaysQuote?: boolean } = {},
): string {
  const delimiter = options.delimiter ?? ";";
  const text = neutralizeSpreadsheetFormula(value);
  const mustQuote =
    options.alwaysQuote === true ||
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\r") ||
    text.includes("\n");
  return mustQuote ? `"${text.replace(/"/g, '""')}"` : text;
}
