import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultPerformanceTracker, type TimingEntry } from "../../../src/utils/PerformanceTracker";
import { getPerfTracker, runWithPerfTracker } from "../../../src/utils/PerfContext";
import type { BootedDevice, ExecResult } from "../../../src/models";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

function ok(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

function buildClient(): AdbClient {
  const client = new AdbClient(
    DEVICE,
    async () => ok(""),
    null,
    defaultRetryExecutor,
    new FakeTimer(),
  );
  // Skip real adb path resolution so the test never shells out.
  (client as unknown as { getBaseCommandParts: () => Promise<unknown> }).getBaseCommandParts =
    async () => ({ adbPath: "adb", baseArgs: [] });
  return client;
}

describe("AdbClient ambient perf span", () => {
  test("records an `adb <subcommand>` span into the ambient tracker", async () => {
    const tracker = new DefaultPerformanceTracker(new FakeTimer());
    const client = buildClient();

    await runWithPerfTracker(tracker, async () => {
      await client.execute(["shell", "input", "keyevent", "KEYCODE_TAB"], { noRetry: true });
    });

    const timings = tracker.getTimings() as TimingEntry[];
    const names = timings.map((entry) => entry.name);
    expect(names).toContain("adb shell input");
  });

  test("does not throw and still runs the command with no ambient tracker", async () => {
    const client = buildClient();
    // No runWithPerfTracker scope: the ambient tracker is the shared no-op.
    expect(getPerfTracker().isEnabled()).toBe(false);
    const result = await client.execute(["devices"], { noRetry: true });
    expect(result.stdout).toBe("");
  });
});
