export type CompanySettings = {
  name: string;
  logoDataUrl: string;
  info: string;
  signatureDataUrl: string;
  textColor: string;
};

const STORAGE_KEY = "stavba.companySettings";

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  name: "",
  logoDataUrl: "",
  info: "",
  signatureDataUrl: "",
  textColor: "",
};

export function loadCompanySettings(): CompanySettings {
  if (typeof window === "undefined") return DEFAULT_COMPANY_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COMPANY_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CompanySettings>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      logoDataUrl:
        typeof parsed.logoDataUrl === "string" ? parsed.logoDataUrl : "",
      info: typeof parsed.info === "string" ? parsed.info : "",
      signatureDataUrl:
        typeof parsed.signatureDataUrl === "string"
          ? parsed.signatureDataUrl
          : "",
      textColor: typeof parsed.textColor === "string" ? parsed.textColor : "",
    };
  } catch {
    return DEFAULT_COMPANY_SETTINGS;
  }
}

export function saveCompanySettings(settings: CompanySettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Convert a #rrggbb hex color to "H S% L%" components for CSS hsl() tokens. */
function hexToHslComponents(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

const TEXT_COLOR_VARS = [
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
];

/**
 * Apply (or reset) a custom text color. Sets the shadcn foreground HSL tokens
 * so the chosen color tints body, card and popover text. Pass an empty string
 * to revert to the stylesheet defaults.
 */
export function applyTextColor(color: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const hsl = color ? hexToHslComponents(color) : null;
  for (const v of TEXT_COLOR_VARS) {
    if (hsl) root.style.setProperty(v, hsl);
    else root.style.removeProperty(v);
  }
}
