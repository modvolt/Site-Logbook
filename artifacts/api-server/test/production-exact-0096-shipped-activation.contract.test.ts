import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_EXACT_0096_PRODUCER_ACTIVATION_ENV,
  runShippedProductionExact0096ProducerSession,
} from "../src/production-exact-0096-backup-producer";
import { PRODUCTION_EXACT_0096_REGISTRY_ACTIVATION } from "../src/lib/production-exact-0096-operation-registry";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe("shipped exact-0096 producer activation contract", () => {
  it("stays unwired without the exact environment activation", async () => {
    const output = capture();
    const code = await runShippedProductionExact0096ProducerSession(
      Readable.from([]),
      { DATABASE_URL: "postgresql://unused.invalid/site_logbook" },
      output.io,
    );
    expect(code).toBe(1);
    expect(output.stderr).toEqual([
      "PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED\n",
    ]);
  });

  it("constructs the complete five-operation registry only with exact activation", async () => {
    const output = capture();
    const code = await runShippedProductionExact0096ProducerSession(
      Readable.from([]),
      {
        DATABASE_URL: "postgresql://unused.invalid/site_logbook",
        [PRODUCTION_EXACT_0096_PRODUCER_ACTIVATION_ENV]:
          PRODUCTION_EXACT_0096_REGISTRY_ACTIVATION,
      },
      output.io,
    );
    expect(code).toBe(1);
    expect(output.stderr).toEqual([
      "PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID\n",
    ]);
    expect(output.stderr).not.toContain(
      "PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED\n",
    );
  });
});
