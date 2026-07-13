import { z } from "zod/v4";

export const checklistResultSchema = z.enum(["done", "defect", "not_applicable"]);
export type ChecklistResult = z.infer<typeof checklistResultSchema>;

const relevanceSchema = z.object({ property: z.string().trim().min(1).max(100), equals: z.boolean().default(true) });
export const checklistItemSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]+$/).max(100),
  title: z.string().trim().min(3).max(500),
  details: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  required: z.boolean().default(true),
  critical: z.boolean().default(false),
  kind: z.enum(["check", "measurement", "photo"]).default("check"),
  relevance: relevanceSchema.optional(),
});
export const checklistPhaseSchema = z.object({
  key: z.enum(["assembly", "inspection", "measurement"]),
  title: z.string().trim().min(3).max(200),
  items: z.array(checklistItemSchema).min(1).max(30),
});
export const checklistDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  phases: z.array(checklistPhaseSchema).length(3),
}).superRefine((definition, ctx) => {
  const phaseKeys = definition.phases.map((phase) => phase.key);
  if (new Set(phaseKeys).size !== phaseKeys.length) ctx.addIssue({ code: "custom", message: "Klíče fází musí být jedinečné." });
  const itemKeys = definition.phases.flatMap((phase) => phase.items.map((item) => item.key));
  if (new Set(itemKeys).size !== itemKeys.length) ctx.addIssue({ code: "custom", message: "Klíče položek musí být v šabloně jedinečné." });
});

export type ChecklistDefinition = z.infer<typeof checklistDefinitionSchema>;
export type ChecklistPhase = ChecklistDefinition["phases"][number];
export type ChecklistItem = ChecklistPhase["items"][number];

const item = (
  key: string,
  title: string,
  options: Partial<Omit<ChecklistItem, "key" | "title">> = {},
): ChecklistItem => ({ key, title, details: [], required: true, critical: false, kind: "check", ...options });

export const DEFAULT_SWITCHBOARD_CHECKLIST: ChecklistDefinition = {
  schemaVersion: 1,
  phases: [
    {
      key: "assembly",
      title: "Sestavení a zapojení",
      items: [
        item("assembly_devices", "Přístroje a jejich hodnoty odpovídají dokumentaci.", { details: ["Přístroje odpovídají kusovníku.", "Jističe mají správné charakteristiky.", "Chrániče mají správný typ a reziduální proud."] }),
        item("assembly_tightening", "Jističe, chrániče a ostatní přístroje jsou správně upevněny a dotaženy.", { critical: true, details: ["Pod kontaktem není izolace.", "Není nepřiměřeně odkrytá měď.", "Dotažení odpovídá požadavku výrobce."] }),
        item("assembly_pe", "PE svorky a ochranné vodiče jsou správně zapojeny a dotaženy.", { critical: true, details: ["Skříň a dveře jsou pospojeny, pokud je to vyžadováno."] }),
        item("assembly_n", "N svorky a N vodiče jsou správně zapojeny a dotaženy.", { critical: true }),
        item("assembly_rcd_groups", "N vodiče jsou správně rozděleny podle jednotlivých chráničových skupin.", { critical: true, relevance: { property: "hasRcd", equals: true } }),
        item("assembly_power_terminals", "Přívodní, vývodní a ostatní silové svorky jsou správně dotaženy.", { critical: true }),
        item("assembly_wires", "Vodiče jsou správně zakončeny, označeny a mechanicky nepoškozeny.", { details: ["Průřezy a barvy vodičů jsou správné.", "Odizolování a dutinky jsou správně provedené.", "Vodiče nejsou nadměrně napnuté.", "Silové a ovládací obvody jsou přehledně vedeny."] }),
        item("assembly_busbars", "Propojovací hřebeny, přípojnice a vnitřní propojení jsou správně osazeny.", { details: ["SPD je správně zapojeno, pokud je osazeno."] }),
        item("assembly_labels", "Popisy přístrojů a okruhů odpovídají dokumentaci."),
        item("assembly_mechanical", "Kryty, záslepky, průchodky a mechanické části jsou správně osazeny."),
      ],
    },
    {
      key: "inspection",
      title: "Kontrola před zapnutím",
      items: [
        item("inspection_scheme", "Zapojení odpovídá schématu a skutečnému určení rozvaděče.", { critical: true }),
        item("inspection_exposed", "Nejsou přítomny volné vodiče, uvolněné části ani odkrytá měď.", { critical: true }),
        item("inspection_rcd_neutral", "N vodiče různých chráničových skupin nejsou nechtěně propojeny.", { critical: true, relevance: { property: "hasRcd", equals: true } }),
        item("inspection_pe", "Ochranné propojení PE je úplné a mechanicky v pořádku.", { critical: true }),
        item("inspection_connections", "Přívod a vývody jsou správně identifikovány a připojeny.", { critical: true }),
        item("inspection_settings", "Nastavení stavitelných přístrojů je správné."),
        item("inspection_clean", "Rozvaděč je mechanicky kompletní a vyčištěný.", { details: ["Skříň není mechanicky poškozená.", "Kabelové vstupy nemají ostré hrany."] }),
        item("inspection_covers", "Kryty a záslepky zajišťují požadovanou ochranu.", { critical: true }),
        item("inspection_open_photo", "Byla pořízena fotografie otevřeného rozvaděče před zakrytováním.", { kind: "photo" }),
        item("inspection_no_critical_defects", "Před zapnutím nejsou evidovány nevyřešené kritické závady.", { critical: true }),
      ],
    },
    {
      key: "measurement",
      title: "Měření, funkční zkoušky a dokončení",
      items: [
        item("measurement_pe_continuity", "Spojitost ochranného obvodu byla ověřena.", { critical: true, kind: "measurement" }),
        item("measurement_insulation", "Izolační odpor byl změřen.", { critical: true, kind: "measurement" }),
        item("measurement_rcd", "Proudové chrániče byly změřeny a výsledky zaznamenány.", { critical: true, kind: "measurement", relevance: { property: "hasRcd", equals: true } }),
        item("measurement_rcd_button", "Testovací tlačítka proudových chráničů byla ověřena.", { relevance: { property: "hasRcd", equals: true } }),
        item("measurement_phase_sequence", "Sled fází byl ověřen.", { kind: "measurement", relevance: { property: "hasThreePhase", equals: true } }),
        item("measurement_main_control", "Funkce hlavního vypínače a ovládacích obvodů byla ověřena."),
        item("measurement_controls", "Funkce signalizace, stykačů nebo relé byla ověřena.", { relevance: { property: "hasContactors", equals: true } }),
        item("measurement_spd", "Stav a zapojení SPD byly zkontrolovány.", { relevance: { property: "hasSpd", equals: true } }),
        item("measurement_label_qr", "Typový štítek a QR kód jsou osazeny a čitelné."),
        item("measurement_final_photo", "Fotodokumentace dokončeného rozvaděče byla pořízena.", { kind: "photo" }),
        item("measurement_defects", "Závady byly odstraněny nebo řádně zaznamenány.", { critical: true }),
        item("measurement_handover", "Rozvaděč je připraven k předání nebo dalšímu navazujícímu kroku.", { critical: true }),
      ],
    },
  ],
};

export function itemIsRelevant(item: ChecklistItem, properties: Record<string, boolean>): boolean {
  if (!item.relevance) return true;
  const actual = properties[item.relevance.property];
  // Unknown applicability remains visible so the technician can decide explicitly.
  return actual == null ? true : actual === item.relevance.equals;
}

export function findChecklistItem(definition: ChecklistDefinition, itemKey: string): { phase: ChecklistPhase; item: ChecklistItem } | null {
  for (const phase of definition.phases) {
    const found = phase.items.find((candidate) => candidate.key === itemKey);
    if (found) return { phase, item: found };
  }
  return null;
}

export type ChecklistResponseValues = {
  result: ChecklistResult;
  value?: string | null;
  unit?: string | null;
  passed?: boolean | null;
  note?: string | null;
  justification?: string | null;
};

export function validateChecklistResponse(item: ChecklistItem, values: ChecklistResponseValues): string | null {
  if (values.result === "defect" && !values.note?.trim()) return "U závady je povinný stručný popis.";
  if (values.result === "not_applicable" && (item.required || item.critical) && !values.justification?.trim()) return "U povinné nebo kritické položky je pro volbu Netýká se povinné zdůvodnění.";
  if (item.kind === "measurement" && values.result === "done" && (!values.value?.trim() || !values.unit?.trim() || values.passed == null)) return "U měření vyplňte hodnotu, jednotku a výsledek.";
  return null;
}

export function evaluatePhaseCompletion(
  phase: ChecklistPhase,
  properties: Record<string, boolean>,
  responses: ReadonlyArray<{ itemKey: string; result: string | null }>,
) {
  const relevant = phase.items.filter((item) => itemIsRelevant(item, properties));
  const missing = relevant.filter((item) => item.required && !responses.some((response) => response.itemKey === item.key && response.result));
  const defects = relevant.filter((item) => responses.some((response) => response.itemKey === item.key && response.result === "defect"));
  return { relevant, missing, defects, canComplete: missing.length === 0 && defects.length === 0 };
}

export function isIdempotentChecklistRetry(
  stored: ChecklistResponseValues & { performedByUserId: number | null },
  incoming: ChecklistResponseValues,
  actorUserId: number | null,
): boolean {
  const normalize = (value: string | null | undefined) => value?.trim() || null;
  return stored.performedByUserId === actorUserId &&
    stored.result === incoming.result &&
    normalize(stored.value) === normalize(incoming.value) &&
    normalize(stored.unit) === normalize(incoming.unit) &&
    (stored.passed ?? null) === (incoming.passed ?? null) &&
    normalize(stored.note) === normalize(incoming.note) &&
    normalize(stored.justification) === normalize(incoming.justification);
}
