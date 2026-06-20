export type CompanySettings = {
  name: string;
  logoDataUrl: string;
  info: string;
  signatureDataUrl: string;
  textColor: string;
  uiScale: number;
};

const STORAGE_KEY = "stavba.companySettings";

/** Default UI scale (1 = 100%, matches the browser's base font size). */
export const DEFAULT_UI_SCALE = 1;

/** Preset zoom levels for the whole UI, ordered from smallest to largest. */
export const UI_SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.8, label: "Nejmenší" },
  { value: 0.9, label: "Kompaktní" },
  { value: 1, label: "Normální" },
  { value: 1.1, label: "Velké" },
  { value: 1.25, label: "Největší" },
];

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  name: "",
  logoDataUrl: "",
  info: "",
  signatureDataUrl: "",
  textColor: "",
  uiScale: DEFAULT_UI_SCALE,
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
      uiScale:
        typeof parsed.uiScale === "number" && parsed.uiScale > 0
          ? parsed.uiScale
          : DEFAULT_UI_SCALE,
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

/**
 * Apply the chosen UI scale by setting the document root font-size. Since the
 * UI is largely sized in `rem` (via Tailwind), scaling the root font-size zooms
 * both text and spacing globally. Pass the default (1) to revert to the
 * browser's base font size.
 */
export function applyUiScale(scale: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const valid = typeof scale === "number" && scale > 0 ? scale : DEFAULT_UI_SCALE;
  if (valid === DEFAULT_UI_SCALE) root.style.removeProperty("font-size");
  else root.style.fontSize = `${Math.round(valid * 100)}%`;
}
