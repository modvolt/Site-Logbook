/**
 * OPTIONAL OpenAI-powered extraction for received cost documents.
 *
 * This module is fully modular: the rest of the application works unchanged when
 * OpenAI is not configured. Nothing here is imported at module-evaluation time in
 * a way that throws; callers must first check `getOpenAiConfig().ready` before
 * attempting an extraction.
 *
 * Extraction reads a PDF / photo and returns a STRICT, Zod-validated suggestion
 * (header fields + lines + an overall confidence + warnings). The result is
 * NEVER auto-approved — the worker persists it as a `needs_review` suggestion for
 * an admin to confirm. Low confidence (< CONFIDENCE_REVIEW_THRESHOLD) adds an
 * explicit warning.
 *
 * Self-hosted production runs on the operator's own infrastructure (Hetzner),
 * where the Replit AI proxy is unavailable, so this uses the operator's own
 * OpenAI API key against the public OpenAI API. The key may be saved in the
 * Settings UI (DB singleton) or provided via OPENAI_API_KEY; it is never
 * returned by the API or logged.
 */
import OpenAI from "openai";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db, openaiSettingsTable } from "@workspace/db";

// ---------------------------------------------------------------------------
// Configuration (DB singleton with environment fallback)
// ---------------------------------------------------------------------------

/** Below this overall confidence we flag the document for closer human review. */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.7;

const SETTINGS_ID = 1;
const DEFAULT_MODEL = "gpt-4o";
// OpenAI itself caps inline inputs (~32 MB per PDF, ~20 MB per image), so this is
// set to OpenAI's practical PDF ceiling. Raising OPENAI_MAX_FILE_MB above that has
// no effect — OpenAI rejects the oversized file and it falls back to manual review.
const DEFAULT_MAX_FILE_MB = 32;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OpenAiConfig {
  /** True when an API key is present (the integration *can* run). */
  configured: boolean;
  /** True when the operator has explicitly turned extraction on. */
  enabled: boolean;
  /** configured && enabled — the only state in which extraction actually runs. */
  ready: boolean;
  model: string;
  maxFileMb: number;
  timeoutMs: number;
  /** System prompt that instructs the model how to read documents. */
  systemPrompt: string;
  /** Below this overall confidence (0–1) a result is flagged for review. */
  confidenceThreshold: number;
  /** Where the active API key comes from: saved settings, env fallback, or none. */
  source: "db" | "env" | "none";
}

/** Internal: config plus the resolved API key (never exposed by the API). */
interface ResolvedOpenAiConfig extends OpenAiConfig {
  apiKey: string | null;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the current configuration from the DB singleton (id = 1), falling back
 * to the OPENAI_* environment variables for any field the operator has not set in
 * the Settings UI. Never throws — safe to call on any request to report status.
 *
 * - API key: the saved key wins; otherwise OPENAI_API_KEY.
 * - Master switch (`enabled`): the saved row's toggle when a row exists,
 *   otherwise OPENAI_DOCUMENT_EXTRACTION_ENABLED === "true".
 * - Model: the saved model, else OPENAI_DOCUMENT_MODEL, else the default.
 */
export async function resolveOpenAiConfig(): Promise<ResolvedOpenAiConfig> {
  let row: typeof openaiSettingsTable.$inferSelect | undefined;
  try {
    [row] = await db
      .select()
      .from(openaiSettingsTable)
      .where(eq(openaiSettingsTable.id, SETTINGS_ID));
  } catch {
    // Table may not exist yet (pre-migration) — fall back to env only.
    row = undefined;
  }

  const dbKey = row?.apiKey?.trim() || null;
  const envKey = process.env.OPENAI_API_KEY?.trim() || null;
  const apiKey = dbKey ?? envKey;
  const configured = Boolean(apiKey);
  const source: "db" | "env" | "none" = dbKey ? "db" : envKey ? "env" : "none";

  // Default OFF: extraction only runs when the operator opts in explicitly
  // (the Settings toggle once a row exists, otherwise the env flag).
  const enabled = row
    ? row.enabled
    : process.env.OPENAI_DOCUMENT_EXTRACTION_ENABLED === "true";

  const model =
    row?.model?.trim() ||
    process.env.OPENAI_DOCUMENT_MODEL?.trim() ||
    DEFAULT_MODEL;

  const maxFileMb =
    row?.maxFileMb && row.maxFileMb > 0
      ? row.maxFileMb
      : parsePositiveNumber(process.env.OPENAI_MAX_FILE_MB, DEFAULT_MAX_FILE_MB);

  const timeoutMs =
    row?.requestTimeoutMs && row.requestTimeoutMs > 0
      ? row.requestTimeoutMs
      : parsePositiveNumber(
          process.env.OPENAI_REQUEST_TIMEOUT_MS,
          DEFAULT_TIMEOUT_MS,
        );

  const systemPrompt = row?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  // Threshold is a 0..1 value, so 0 (never warn) is legitimate — parsePositiveNumber
  // would reject it. Accept any finite env number, then clamp; invalid → default.
  const envThreshold = process.env.OPENAI_CONFIDENCE_THRESHOLD?.trim();
  const rawThreshold =
    row?.confidenceThreshold != null
      ? row.confidenceThreshold
      : envThreshold
        ? Number(envThreshold)
        : CONFIDENCE_REVIEW_THRESHOLD;
  const confidenceThreshold = Number.isFinite(rawThreshold)
    ? Math.min(1, Math.max(0, rawThreshold))
    : CONFIDENCE_REVIEW_THRESHOLD;

  return {
    apiKey,
    configured,
    enabled,
    ready: configured && enabled,
    model,
    maxFileMb,
    timeoutMs,
    systemPrompt,
    confidenceThreshold,
    source,
  };
}

function getClient(cfg: ResolvedOpenAiConfig): OpenAI {
  if (!cfg.apiKey) {
    throw new Error("OPENAI_API_KEY není nastaven.");
  }
  return new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs });
}

// ---------------------------------------------------------------------------
// Supported input types
// ---------------------------------------------------------------------------

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function isSupportedForAi(contentType: string | null | undefined, fileName: string | null | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "application/pdf") return true;
  if (IMAGE_MIME.has(ct)) return true;
  const name = (fileName ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return true;
  return /\.(jpe?g|png|webp|gif)$/.test(name);
}

function detectMime(contentType: string | null | undefined, fileName: string | null | undefined): "application/pdf" | string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "application/pdf" || IMAGE_MIME.has(ct)) return ct;
  const name = (fileName ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

// ---------------------------------------------------------------------------
// Strict extraction schema (what the model must return)
// ---------------------------------------------------------------------------

const LINE_TYPES = ["material", "work", "transport", "other"] as const;
const DOC_TYPES = ["receipt", "delivery_note", "invoice", "credit_note"] as const;

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null));

const nullableNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : v;
    return Number.isFinite(n) ? n : null;
  });

const REFERENCE_TYPES = [
  "delivery_note",
  "summary_delivery_note",
  "delivery",
  "order",
  "supplier_order",
  "project",
  "invoice",
  "credit_note",
  "other",
] as const;

/** A single suggested document line. Quantities/prices may be absent. */
const ExtractedLineSchema = z.object({
  description: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : "")),
  lineType: z
    .union([z.enum(LINE_TYPES), z.null()])
    .optional()
    .transform((v) => v ?? "material"),
  quantity: nullableNumber,
  unit: nullableString,
  unitPriceWithoutVat: nullableNumber,
  vatRate: nullableNumber,
  // Richer supplier-catalogue fields (DEK/Schrack/Varnet/K&V samples).
  supplierSku: nullableString,
  ean: nullableString,
  manufacturer: nullableString,
  discountPercent: nullableNumber,
  listPrice: nullableNumber,
  // Recycling / environmental (PHE) fees often appear as their own lines.
  environmentalFee: nullableNumber,
  isEnvironmentalFee: z
    .union([z.boolean(), z.null()])
    .optional()
    .transform((v) => v ?? false),
});

/** The full strict result the model is asked to produce. */
export const ExtractionResultSchema = z.object({
  docType: z
    .union([z.enum(DOC_TYPES), z.null()])
    .optional()
    .transform((v) => v ?? null),
  supplierName: nullableString,
  supplierIc: nullableString,
  supplierDic: nullableString,
  supplierAddress: nullableString,
  documentNumber: nullableString,
  variableSymbol: nullableString,
  issueDate: nullableString,
  taxableSupplyDate: nullableString,
  dueDate: nullableString,
  currency: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : "CZK")),
  subtotalWithoutVat: nullableNumber,
  totalVat: nullableNumber,
  totalWithVat: nullableNumber,
  // Supplier payment/context details often present on invoices.
  bankAccount: nullableString,
  iban: nullableString,
  constantSymbol: nullableString,
  orderNumber: nullableString,
  // References to related documents (delivery notes, orders, projects, …).
  relatedDocuments: z
    .union([
      z.array(
        z.object({
          referenceType: z
            .union([z.enum(REFERENCE_TYPES), z.null()])
            .optional()
            .transform((v) => v ?? "other"),
          referenceNumber: z
            .union([z.string(), z.null()])
            .optional()
            .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : "")),
        }),
      ),
      z.null(),
    ])
    .optional()
    .transform((v) => (v ?? []).filter((r) => r.referenceNumber)),
  lines: z
    .union([z.array(ExtractedLineSchema), z.null()])
    .optional()
    .transform((v) => v ?? []),
  confidence: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return 0;
      const n = typeof v === "string" ? Number(v) : v;
      if (!Number.isFinite(n)) return 0;
      return Math.min(1, Math.max(0, n));
    }),
  warnings: z
    .union([z.array(z.string()), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
      if (typeof v === "string" && v.trim()) return [v.trim()];
      return [];
    }),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Final normalization after Zod parsing: drop non-ISO dates (the model is asked
 * for YYYY-MM-DD but we never trust it blindly), and add a low-confidence
 * warning so the reviewer is explicitly told to double-check.
 */
export function normalizeResult(
  result: ExtractionResult,
  threshold: number = CONFIDENCE_REVIEW_THRESHOLD,
): ExtractionResult {
  const cleanDate = (d: string | null): string | null =>
    d && ISO_DATE.test(d) ? d : null;

  const warnings = [...result.warnings];
  if (result.confidence < threshold) {
    warnings.push(
      `Nízká důvěryhodnost automatického vytěžení (${Math.round(
        result.confidence * 100,
      )} %). Pečlivě zkontrolujte všechny údaje.`,
    );
  }

  return {
    ...result,
    issueDate: cleanDate(result.issueDate),
    taxableSupplyDate: cleanDate(result.taxableSupplyDate),
    dueDate: cleanDate(result.dueDate),
    lines: result.lines.filter((l) => l.description),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `Jsi přesný asistent pro vytěžování českých účetních dokladů (faktury, účtenky, dodací listy, dobropisy) pro stavební firmu.

Z přiloženého dokladu vyčti údaje a vrať VÝHRADNĚ jeden JSON objekt (žádný další text, žádné markdown bloky) s tímto tvarem:
{
  "docType": "receipt" | "delivery_note" | "invoice" | "credit_note" | null,
  "supplierName": string | null,
  "supplierIc": string | null,        // IČO dodavatele
  "supplierDic": string | null,       // DIČ dodavatele
  "supplierAddress": string | null,
  "documentNumber": string | null,    // číslo dokladu / faktury
  "variableSymbol": string | null,
  "issueDate": "YYYY-MM-DD" | null,           // datum vystavení
  "taxableSupplyDate": "YYYY-MM-DD" | null,   // datum zdanitelného plnění (DUZP)
  "dueDate": "YYYY-MM-DD" | null,             // datum splatnosti
  "currency": string,                 // např. "CZK", "EUR"; výchozí "CZK"
  "subtotalWithoutVat": number | null, // základ daně celkem (bez DPH)
  "totalVat": number | null,           // DPH celkem
  "totalWithVat": number | null,       // celkem k úhradě (s DPH)
  "bankAccount": string | null,        // číslo bankovního účtu dodavatele
  "iban": string | null,
  "constantSymbol": string | null,
  "orderNumber": string | null,        // číslo objednávky odběratele, je-li uvedeno
  "relatedDocuments": [                 // odkazy na související doklady
    {
      "referenceType": "delivery_note" | "summary_delivery_note" | "delivery" | "order" | "supplier_order" | "project" | "invoice" | "credit_note" | "other",
      "referenceNumber": string
    }
  ],
  "lines": [
    {
      "description": string,
      "lineType": "material" | "work" | "transport" | "other",
      "quantity": number | null,
      "unit": string | null,
      "unitPriceWithoutVat": number | null,  // jednotková cena bez DPH (po slevě)
      "vatRate": number | null,              // sazba DPH v procentech, např. 21
      "supplierSku": string | null,          // katalogové/objednací číslo dodavatele
      "ean": string | null,                  // EAN / čárový kód
      "manufacturer": string | null,         // výrobce / značka
      "discountPercent": number | null,      // sleva v procentech, je-li uvedena
      "listPrice": number | null,            // ceníková (katalogová) cena před slevou
      "environmentalFee": number | null,     // recyklační / ekologický poplatek (PHE) k položce
      "isEnvironmentalFee": boolean          // true, pokud JE celá položka jen recyklační/ekologický poplatek
    }
  ],
  "confidence": number,   // 0..1 celková důvěryhodnost vytěžení
  "warnings": string[]    // česky; cokoliv nejistého nebo nečitelného
}

Pravidla:
- Čísla vracej jako čísla (tečka jako desetinný oddělovač), bez měny a mezer.
- Pokud údaj v dokladu není nebo je nečitelný, vrať null (a zmiň to ve "warnings"). NIKDY si údaje nevymýšlej.
- Datumy převeď do formátu YYYY-MM-DD.
- "lineType" odhadni podle popisu položky (materiál vs. práce vs. doprava vs. ostatní).
- U položek vyplň "supplierSku", "ean", "manufacturer", jsou-li v dokladu (typické pro dodavatele DEK, Schrack, Varnet, K&V).
- Je-li u položky sleva, vyplň "discountPercent" a "listPrice"; "unitPriceWithoutVat" vždy uváděj jako cenu PO slevě.
- Recyklační/ekologické poplatky (PHE) označ: buď jako "environmentalFee" u dané položky, nebo (je-li poplatek samostatnou řádkou) nastav "isEnvironmentalFee": true.
- Do "relatedDocuments" vlož všechny odkazy na související doklady uvedené na dokladu (dodací listy, objednávky, čísla zakázek/projektů).
- "confidence" sniž, pokud je doklad nečitelný, neúplný nebo si nejsi jistý.`;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractionRaw {
  result: ExtractionResult;
  rawText: string;
  model: string;
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip an accidental ```json ... ``` fence if the model added one.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

/**
 * Run extraction on a document file (PDF or image). Returns the validated +
 * normalized result plus the raw model text (stored for audit). Throws on
 * unsupported types, oversized files, missing config, or API/parse errors — the
 * worker translates a throw into a retryable failure.
 */
export async function extractFromFile(
  buffer: Buffer,
  contentType: string | null | undefined,
  fileName: string | null | undefined,
): Promise<ExtractionRaw> {
  const cfg = await resolveOpenAiConfig();
  if (!cfg.configured) {
    throw new Error("OpenAI není nakonfigurováno (chybí OPENAI_API_KEY).");
  }
  if (!isSupportedForAi(contentType, fileName)) {
    throw new Error(
      `Typ souboru není podporován pro AI vytěžení (${contentType ?? fileName ?? "neznámý"}).`,
    );
  }
  const sizeMb = buffer.byteLength / (1024 * 1024);
  if (sizeMb > cfg.maxFileMb) {
    throw new Error(
      `Soubor je příliš velký pro AI vytěžení (${sizeMb.toFixed(1)} MB > ${cfg.maxFileMb} MB).`,
    );
  }

  const client = getClient(cfg);
  const mime = detectMime(contentType, fileName);
  const base64 = buffer.toString("base64");

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: "Vytěž údaje z tohoto dokladu a vrať pouze JSON dle instrukcí.",
    },
  ];

  if (mime === "application/pdf") {
    userContent.push({
      type: "file",
      file: {
        filename: fileName || "document.pdf",
        file_data: `data:application/pdf;base64,${base64}`,
      },
    });
  } else {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    });
  }

  const completion = await client.chat.completions.create({
    model: cfg.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: cfg.systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const rawText = completion.choices[0]?.message?.content?.trim() ?? "";
  if (!rawText) {
    throw new Error("OpenAI nevrátil žádný obsah.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = parseModelJson(rawText);
  } catch {
    throw new Error("Odpověď OpenAI nelze zpracovat jako JSON.");
  }

  const validated = ExtractionResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new Error(`Odpověď OpenAI neodpovídá očekávanému tvaru: ${validated.error.message}`);
  }

  return {
    result: normalizeResult(validated.data, cfg.confidenceThreshold),
    rawText,
    model: completion.model || cfg.model,
  };
}

// ---------------------------------------------------------------------------
// Connectivity test (sends NO real document)
// ---------------------------------------------------------------------------

export interface TestResult {
  ok: boolean;
  model: string;
  message: string;
}

/**
 * Verify the configuration by making a tiny, no-document call to the model. This
 * confirms the API key is valid and the configured model is reachable WITHOUT
 * uploading any customer document. Never throws — returns a result object.
 */
export async function testConfiguration(): Promise<TestResult> {
  const cfg = await resolveOpenAiConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      model: cfg.model,
      message: "OpenAI není nakonfigurováno – chybí OPENAI_API_KEY.",
    };
  }

  try {
    const client = getClient(cfg);
    const completion = await client.chat.completions.create({
      model: cfg.model,
      max_completion_tokens: 5,
      messages: [
        {
          role: "user",
          content: 'Odpověz pouze slovem "OK".',
        },
      ],
    });
    const reply = completion.choices[0]?.message?.content?.trim() ?? "";
    return {
      ok: true,
      model: completion.model || cfg.model,
      message: `Spojení s OpenAI funguje. Model "${completion.model || cfg.model}" odpověděl${
        reply ? `: "${reply}"` : "."
      }`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznámá chyba.";
    return {
      ok: false,
      model: cfg.model,
      message: `Spojení s OpenAI selhalo: ${message}`,
    };
  }
}
