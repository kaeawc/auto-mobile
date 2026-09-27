import { test } from "bun:test";
import { writeFileSync } from "node:fs";

// The shell gate runs this file with a short outer watchdog. Blocking the
// event loop proves that the watchdog bounds a real Bun process even when
// Bun's per-test timeout cannot fire.
test("integration runner watchdog probe", () => {
  const pidFile = process.env.AUTOMOBILE_INTEGRATION_STALL_PID_FILE;
  if (!pidFile) {
    return;
  }
  writeFileSync(pidFile, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
