export const LEGACY_PPE_TOKEN_TYPES = [
  "ppe_signature",
  "ppe_confirmation",
] as const;

export type LegacyPpeTokenType = (typeof LEGACY_PPE_TOKEN_TYPES)[number];

export type LegacyPpeMaxAgeDays = Readonly<
  Record<LegacyPpeTokenType, number>
>;

const MAX_POLICY_AGE_DAYS = 3_650;

function policyEntry(raw: string): [LegacyPpeTokenType, number] {
  const separator = raw.indexOf(":");
  if (separator < 1 || separator !== raw.lastIndexOf(":")) {
    throw new Error(
      "--max-age-days must use <ppe_signature|ppe_confirmation>:<days>.",
    );
  }

  const type = raw.slice(0, separator);
  if (!LEGACY_PPE_TOKEN_TYPES.includes(type as LegacyPpeTokenType)) {
    throw new Error(
      `Unsupported PPE token type ${JSON.stringify(type)} for --max-age-days.`,
    );
  }

  const days = Number(raw.slice(separator + 1));
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > MAX_POLICY_AGE_DAYS
  ) {
    throw new Error(
      `--max-age-days=${type}:<days> requires an integer from 1 to ${MAX_POLICY_AGE_DAYS}.`,
    );
  }

  return [type as LegacyPpeTokenType, days];
}

export function parseLegacyPpeMaxAgeDays(
  args: readonly string[],
): LegacyPpeMaxAgeDays {
  const prefix = "--max-age-days=";
  const entries = args
    .filter((value) => value.startsWith(prefix))
    .map((value) => policyEntry(value.slice(prefix.length)));
  const policy = new Map<LegacyPpeTokenType, number>();

  for (const [type, days] of entries) {
    if (policy.has(type)) {
      throw new Error(`Duplicate --max-age-days policy for ${type}.`);
    }
    policy.set(type, days);
  }

  const missing = LEGACY_PPE_TOKEN_TYPES.filter((type) => !policy.has(type));
  if (missing.length > 0) {
    throw new Error(
      `Missing --max-age-days policy for ${missing.join(", ")}. Both PPE token types are required.`,
    );
  }

  return Object.freeze({
    ppe_signature: policy.get("ppe_signature")!,
    ppe_confirmation: policy.get("ppe_confirmation")!,
  });
}
