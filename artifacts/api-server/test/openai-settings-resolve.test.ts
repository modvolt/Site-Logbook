import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, openaiSettingsTable } from "@workspace/db";
import { resolveOpenAiConfig } from "../src/lib/openai-extraction";

/**
 * resolveOpenAiConfig precedence (DB-backed).
 *
 * The OpenAI document-extraction config is a DB singleton (openai_settings,
 * id=1) that wins per-field over the OPENAI_* env vars, with env as the fallback.
 * This guards the self-hosted "configure in the admin UI without redeploy" path
 * while keeping existing env-only deployments working unchanged.
 *
 * Runs against the dev database (DATABASE_URL); env vars are saved/restored and
 * the singleton row is cleared between cases so the suite is self-contained.
 */

const SETTINGS_ID = 1;

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_DOCUMENT_MODEL",
  "OPENAI_DOCUMENT_EXTRACTION_ENABLED",
  "OPENAI_MAX_FILE_MB",
  "OPENAI_REQUEST_TIMEOUT_MS",
  "OPENAI_CONFIDENCE_THRESHOLD",
] as const;

const saved: Record<string, string | undefined> = {};

async function clearRow(): Promise<void> {
  await db.delete(openaiSettingsTable).where(eq(openaiSettingsTable.id, SETTINGS_ID));
}

async function setRow(values: {
  enabled: boolean;
  apiKey: string | null;
  model: string | null;
  systemPrompt?: string | null;
  maxFileMb?: number | null;
  requestTimeoutMs?: number | null;
  confidenceThreshold?: number | null;
}): Promise<void> {
  const row = { id: SETTINGS_ID, ...values, updatedAt: new Date() };
  await db
    .insert(openaiSettingsTable)
    .values(row)
    .onConflictDoUpdate({ target: openaiSettingsTable.id, set: row });
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  await clearRow();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await clearRow();
});

afterAll(async () => {
  await clearRow();
});

describe("resolveOpenAiConfig precedence", () => {
  it("reports none/unconfigured when neither DB row nor env key exist", async () => {
    const cfg = await resolveOpenAiConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.ready).toBe(false);
    expect(cfg.source).toBe("none");
  });

  it("falls back to OPENAI_* env when no DB row exists", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.OPENAI_DOCUMENT_MODEL = "gpt-4o-mini";
    process.env.OPENAI_DOCUMENT_EXTRACTION_ENABLED = "true";
    const cfg = await resolveOpenAiConfig();
    expect(cfg.source).toBe("env");
    expect(cfg.configured).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect(cfg.ready).toBe(true);
    expect(cfg.model).toBe("gpt-4o-mini");
  });

  it("DB key + model + enabled toggle win over env", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.OPENAI_DOCUMENT_MODEL = "gpt-4o-mini";
    await setRow({ enabled: true, apiKey: "sk-db", model: "gpt-4.1" });
    const cfg = await resolveOpenAiConfig();
    expect(cfg.source).toBe("db");
    expect(cfg.configured).toBe(true);
    expect(cfg.ready).toBe(true);
    expect(cfg.model).toBe("gpt-4.1");
  });

  it("defaults prompt/maxFileMb/timeout/threshold when neither DB nor env set them", async () => {
    const cfg = await resolveOpenAiConfig();
    expect(cfg.maxFileMb).toBe(32);
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.confidenceThreshold).toBeCloseTo(0.8);
    expect(cfg.systemPrompt).toContain("asistent");
  });

  it("advanced env fallbacks apply when no DB row exists", async () => {
    process.env.OPENAI_MAX_FILE_MB = "20";
    process.env.OPENAI_REQUEST_TIMEOUT_MS = "12000";
    process.env.OPENAI_CONFIDENCE_THRESHOLD = "0.5";
    const cfg = await resolveOpenAiConfig();
    expect(cfg.maxFileMb).toBe(20);
    expect(cfg.timeoutMs).toBe(12000);
    expect(cfg.confidenceThreshold).toBeCloseTo(0.5);
  });

  it("accepts env confidence threshold of 0 (never-warn), not just positive values", async () => {
    process.env.OPENAI_CONFIDENCE_THRESHOLD = "0";
    const cfg = await resolveOpenAiConfig();
    expect(cfg.confidenceThreshold).toBe(0);
  });

  it("DB advanced fields win over env, and clamp the threshold to 0..1", async () => {
    process.env.OPENAI_MAX_FILE_MB = "20";
    process.env.OPENAI_CONFIDENCE_THRESHOLD = "0.5";
    await setRow({
      enabled: true,
      apiKey: "sk-db",
      model: "gpt-4.1",
      systemPrompt: "Vlastní prompt",
      maxFileMb: 64,
      requestTimeoutMs: 90_000,
      confidenceThreshold: 1.5,
    });
    const cfg = await resolveOpenAiConfig();
    expect(cfg.maxFileMb).toBe(64);
    expect(cfg.timeoutMs).toBe(90_000);
    expect(cfg.systemPrompt).toBe("Vlastní prompt");
    expect(cfg.confidenceThreshold).toBe(1);
  });

  it("blank DB prompt falls back to the built-in default prompt", async () => {
    await setRow({
      enabled: true,
      apiKey: "sk-db",
      model: "gpt-4o",
      systemPrompt: "   ",
    });
    const cfg = await resolveOpenAiConfig();
    expect(cfg.systemPrompt).toContain("asistent");
  });

  it("uses env key when DB row has no key, and the row's enabled toggle applies", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    await setRow({ enabled: false, apiKey: null, model: null });
    const cfg = await resolveOpenAiConfig();
    // No DB key -> the active key (and thus source) comes from env.
    expect(cfg.source).toBe("env");
    expect(cfg.configured).toBe(true);
    // A row exists with enabled=false -> overrides the env flag default.
    expect(cfg.enabled).toBe(false);
    expect(cfg.ready).toBe(false);
    // Model falls back to the built-in default when neither row nor env set it.
    expect(cfg.model).toBe("gpt-4o");
  });
});
