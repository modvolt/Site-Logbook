const PRAGUE_TIME_ZONE = "Europe/Prague";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class QuoteValidityError extends Error {
  constructor(readonly code: "invalid_valid_until" | "quote_expired") {
    super(code);
    this.name = "QuoteValidityError";
  }
}

function offsetAt(utcMillis: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PRAGUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMillis));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value);
  const representedAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return representedAsUtc - utcMillis;
}

/** End of the inclusive business date in Europe/Prague. */
export function quoteValidityDeadline(validUntil: string): Date {
  const match = DATE_PATTERN.exec(validUntil);
  if (!match) throw new QuoteValidityError("invalid_valid_until");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextLocalMidnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new QuoteValidityError("invalid_valid_until");
  }
  let utcMillis = nextLocalMidnightAsUtc;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    utcMillis = nextLocalMidnightAsUtc - offsetAt(utcMillis);
  }
  return new Date(utcMillis - 1);
}

export function quoteDecisionExpiresAt(
  configuredExpiry: Date,
  validUntil: string | null,
  now = new Date(),
): Date {
  if (!validUntil) return configuredExpiry;
  const deadline = quoteValidityDeadline(validUntil);
  if (deadline.getTime() <= now.getTime()) {
    throw new QuoteValidityError("quote_expired");
  }
  return deadline < configuredExpiry ? deadline : configuredExpiry;
}

export function assertQuoteDecisionStillValid(
  validUntil: string | null,
  now = new Date(),
): void {
  if (validUntil && quoteValidityDeadline(validUntil).getTime() <= now.getTime()) {
    throw new QuoteValidityError("quote_expired");
  }
}
