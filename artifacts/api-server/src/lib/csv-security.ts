const FORMULA_PREFIX_AFTER_CONTROL = /^[\u0000-\u0020]*[=+\-@]/;

/**
 * Keep user-controlled text from being interpreted as a formula when a CSV is
 * opened in spreadsheet software. Numbers remain numeric; suspicious strings
 * get a leading apostrophe before any whitespace/control prefix.
 */
export function neutralizeSpreadsheetFormula(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (typeof value !== "string") return text;
  return FORMULA_PREFIX_AFTER_CONTROL.test(text) ? `'${text}` : text;
}

export function encodeCsvCell(
  value: unknown,
  options: { delimiter?: string; alwaysQuote?: boolean } = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const text = neutralizeSpreadsheetFormula(value);
  const mustQuote =
    options.alwaysQuote === true ||
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\r") ||
    text.includes("\n");
  return mustQuote ? `"${text.replace(/"/g, '""')}"` : text;
}
