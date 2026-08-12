import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SIDE_EFFECT_CALLSITE_INVENTORY_V1,
  type SideEffectCallsiteSymbol,
} from "../src/lib/side-effect-callsite-policy";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("../src", import.meta.url)));

const SYMBOL_PATTERNS: ReadonlyArray<{
  symbol: SideEffectCallsiteSymbol;
  invocation: RegExp;
  declaration?: RegExp;
}> = [
  { symbol: ".sendMail", invocation: /\.sendMail\s*\(/g },
  { symbol: ".putPrivateObject", invocation: /\.putPrivateObject\s*\(/g },
  {
    symbol: ".deletePrivateObject",
    invocation: /\.deletePrivateObject\s*\(/g,
  },
  {
    symbol: ".putPrivateObjectRecoveryStream",
    invocation: /\.putPrivateObjectRecoveryStream\s*\(/g,
  },
  {
    symbol: "sendEmailWithPdf",
    invocation: /\bsendEmailWithPdf\s*\(/g,
    declaration: /\bfunction\s+sendEmailWithPdf\s*\(/g,
  },
  {
    symbol: "sendPlainEmail",
    invocation: /\bsendPlainEmail\s*\(/g,
    declaration: /\bfunction\s+sendPlainEmail\s*\(/g,
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function key(value: { file: string; symbol: string }): string {
  return `${value.file}|${value.symbol}`;
}

function normalizedInventory() {
  return SIDE_EFFECT_CALLSITE_INVENTORY_V1.map((entry) => ({
    file: entry.file,
    symbol: entry.symbol,
    occurrences: entry.occurrences,
  })).sort((left, right) => key(left).localeCompare(key(right)));
}

function scannedInventory() {
  return sourceFiles(SOURCE_ROOT)
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relativeFile = relative(SOURCE_ROOT, file).replaceAll("\\", "/");
      return SYMBOL_PATTERNS.flatMap(({ symbol, invocation, declaration }) => {
        const occurrences =
          count(source, invocation) -
          (declaration === undefined ? 0 : count(source, declaration));
        return occurrences > 0
          ? [{ file: relativeFile, symbol, occurrences }]
          : [];
      });
    })
    .sort((left, right) => key(left).localeCompare(key(right)));
}

describe("side-effect callsite inventory", () => {
  it("matches every delivery, managed-object, and recovery-stream invocation", () => {
    expect(scannedInventory()).toEqual(normalizedInventory());
  });

  it("contains no duplicates and keeps every classification fail-closed", () => {
    const keys = SIDE_EFFECT_CALLSITE_INVENTORY_V1.map(key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const entry of SIDE_EFFECT_CALLSITE_INVENTORY_V1) {
      expect(entry.occurrences).toBeGreaterThan(0);
      if (entry.symbol === ".putPrivateObjectRecoveryStream") {
        expect(entry).toMatchObject({
          kind: "managed-object",
          boundary: "recovery-plane",
          migrationStatus: "independently-bound",
        });
      } else {
        expect(entry.migrationStatus).toBe("legacy-unbound");
        expect(entry.boundary).not.toBe("recovery-plane");
      }

      const delivery = [
        ".sendMail",
        "sendEmailWithPdf",
        "sendPlainEmail",
      ].includes(entry.symbol);
      expect(entry.kind).toBe(delivery ? "delivery" : "managed-object");
    }
  });

  it("distinguishes provider adaptation from product callers", () => {
    expect(
      SIDE_EFFECT_CALLSITE_INVENTORY_V1.filter(
        (entry) => entry.boundary === "provider-adapter",
      ),
    ).toEqual([
      expect.objectContaining({
        file: "lib/email.ts",
        symbol: ".sendMail",
        occurrences: 3,
      }),
    ]);
  });

  it("locks the reviewed checkpoint totals", () => {
    const total = (
      predicate: (
        entry: (typeof SIDE_EFFECT_CALLSITE_INVENTORY_V1)[number],
      ) => boolean,
    ) =>
      SIDE_EFFECT_CALLSITE_INVENTORY_V1.filter(predicate).reduce(
        (sum, entry) => sum + entry.occurrences,
        0,
      );

    expect(total((entry) => entry.kind === "delivery")).toBe(13);
    expect(
      total(
        (entry) =>
          entry.kind === "managed-object" &&
          entry.migrationStatus === "legacy-unbound",
      ),
    ).toBe(47);
    expect(
      total((entry) => entry.migrationStatus === "independently-bound"),
    ).toBe(2);
    expect(SIDE_EFFECT_CALLSITE_INVENTORY_V1).toHaveLength(40);
  });
});
