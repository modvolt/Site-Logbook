import { DEFAULT_EXPORT_COLUMNS, type ExportColumnKey } from "./export-jobs";

export type ExportPreset = {
  id: string;
  name: string;
  columns: ExportColumnKey[];
};

const STORAGE_KEY = "stavba.exportPresets.v1";

function isExportColumnKey(value: unknown): value is ExportColumnKey {
  return (
    typeof value === "string" &&
    (DEFAULT_EXPORT_COLUMNS as readonly string[]).includes(value)
  );
}

function sanitize(raw: unknown): ExportPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ExportPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const cols = Array.isArray(obj.columns)
      ? obj.columns.filter(isExportColumnKey)
      : [];
    if (!id || !name) continue;
    out.push({ id, name, columns: cols });
  }
  return out;
}

export function loadPresets(): ExportPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function savePresets(presets: ExportPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore quota / availability errors
  }
}

export function createPresetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
