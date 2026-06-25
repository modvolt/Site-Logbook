import { forwardRef, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DecimalInputProps extends Omit<React.ComponentProps<typeof Input>, "type" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  /** Validation error message. When set, the input gets a red border and the message is shown below. */
  error?: string;
}

/**
 * Numeric text input that accepts both Czech comma (1,5) and period (1.5) as
 * decimal separators. Always stores the raw string so the parent can display
 * exactly what the user typed; convert to a number only on submit via
 * `parseDecimal(value)`.
 *
 * Pass `error` (a non-empty string) to show a red border and an inline error
 * message below the field. Use `decimalError()` to derive the message.
 */
export const DecimalInput = forwardRef<HTMLInputElement, DecimalInputProps>(
  ({ value, onChange, className, error, ...rest }, ref) => {
    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    };

    return (
      <>
        <Input
          ref={ref}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={handleChange}
          aria-invalid={!!error}
          className={cn(
            error && "border-destructive focus-visible:ring-destructive",
            className,
          )}
          {...rest}
        />
        {error && (
          <p className="text-destructive text-xs mt-1 leading-tight">{error}</p>
        )}
      </>
    );
  },
);
DecimalInput.displayName = "DecimalInput";

/**
 * Parse a string that may use comma or period as decimal separator.
 * Returns null for empty or invalid input.
 */
export function parseDecimal(v: string): number | null {
  if (v == null) return null;
  const t = String(v).trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns a Czech error message if the value is non-empty but invalid.
 * Returns undefined when the value is empty (blank is allowed — use required
 * validation separately) or when the value is a valid number.
 *
 * @param v       Raw string from DecimalInput
 * @param opts
 *   - allowNegative  Allow values below zero (default: false — negatives error)
 *   - positiveOnly   Value must be strictly > 0 (implies allowNegative: false)
 */
export function decimalError(
  v: string,
  opts?: { allowNegative?: boolean; positiveOnly?: boolean },
): string | undefined {
  const t = (v ?? "").trim();
  if (t === "") return undefined;
  const n = parseDecimal(v);
  if (n === null) return "Neplatné číslo";
  if (opts?.positiveOnly && n <= 0) return "Musí být větší než 0";
  if (!opts?.allowNegative && n < 0) return "Nesmí být záporné";
  return undefined;
}
