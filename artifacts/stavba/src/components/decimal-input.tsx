import { forwardRef, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DecimalInputProps extends Omit<React.ComponentProps<typeof Input>, "type" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Numeric text input that accepts both Czech comma (1,5) and period (1.5) as
 * decimal separators. Always stores the raw string so the parent can display
 * exactly what the user typed; convert to a number only on submit via
 * `parseDecimal(value)`.
 */
export const DecimalInput = forwardRef<HTMLInputElement, DecimalInputProps>(
  ({ value, onChange, className, ...rest }, ref) => {
    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    };

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        className={cn(className)}
        {...rest}
      />
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
