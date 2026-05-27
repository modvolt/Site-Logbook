export type CompanySettings = {
  name: string;
  logoDataUrl: string;
};

const STORAGE_KEY = "stavba.companySettings";

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  name: "",
  logoDataUrl: "",
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
    };
  } catch {
    return DEFAULT_COMPANY_SETTINGS;
  }
}

export function saveCompanySettings(settings: CompanySettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
