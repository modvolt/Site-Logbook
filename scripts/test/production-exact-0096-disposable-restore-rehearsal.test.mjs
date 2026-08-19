import assert from "node:assert/strict";
import test from "node:test";
import { runProductionExact0096DisposableRestoreRehearsal } from "../production-exact-0096-disposable-restore-rehearsal.mjs";

test("local Docker rehearsal remains default-dark", async () => {
  let called = false;
  await assert.rejects(
    () =>
      runProductionExact0096DisposableRestoreRehearsal("wrong", {
        execFile: async () => {
          called = true;
        },
      }),
    /REHEARSAL_DARK/,
  );
  assert.equal(called, false);
});
