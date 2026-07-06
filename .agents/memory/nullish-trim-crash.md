---
name: Nullish-coalescing trim crash pattern
description: Why `(x ?? "").trim()` still throws on non-string values, and the fix convention used across Stavba's shared input helpers.
---

`??` only substitutes a fallback when the left side is `null`/`undefined`. If a
value is a number, boolean, or object (e.g. corrupted data, a mistyped prop,
a CSV cell PapaParse hands back as something unexpected), `(x ?? "").trim()`
leaves `x` untouched and `.trim()` throws `TypeError: x.trim is not a
function`, white-screening the page in React.

**Why:** this crash surfaced in production (Stavba job tracker) from several
independent call sites at once — Autocomplete suggestions, DecimalInput's
decimalError(), the network topology diagram's device-name normalizer, and
the warehouse/customer CSV import row mappers — because they all copied the
same `(x ?? "").trim()` idiom.

**How to apply:** whenever trimming a value that isn't statically guaranteed
to be a string (anything sourced from an API response, DB row, CSV cell, or
`any`-typed prop), write `String(x ?? "").trim()` instead. Do this at both
the shared-helper level (e.g. `decimalError`) and, where feasible, at the
data source (e.g. `.map(w => String(w.name ?? ""))`) so a bad value can't
even reach the shared helper un-coerced.
