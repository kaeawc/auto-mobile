import { describe, expect, test } from "bun:test";
import { readAndroidDeviceApiLevel } from "../../../src/utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";

/**
 * The API-level read must not spend more than ONE budget across its primary probe
 * and its getprop fallback (#3351). Production `AdbClient.getAndroidApiLevel`
 * probes getprop internally; when that times out and returns null, the fallback
 * used to launch the SAME getprop again with the FULL original timeout — up to 2x
 * the request deadline, holding the daemon's per-device queue that whole time.
 *
 * These drive `readAndroidDeviceApiLevel` directly with a FakeTimer so the elapsed
 * accounting is deterministic: the primary consumes budget by advancing the clock,
 * and we observe exactly what the fallback is charged.
 */
function ok(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

interface Probe {
  fallbackCalls: number;
  fallbackTimeoutMs: number | undefined;
}

/**
 * An executor whose primary `getAndroidApiLevel` consumes `primaryElapsedMs` of
 * the budget (by advancing `timer`) and then returns null — modelling a real
 * AdbClient whose internal getprop timed out — and whose `executeCommand`
 * fallback records the timeout it is charged.
 */
function budgetProbe(
  timer: FakeTimer,
  primaryElapsedMs: number,
  fallbackStdout: string,
): { adb: AdbExecutor; probe: Probe } {
  const probe: Probe = { fallbackCalls: 0, fallbackTimeoutMs: undefined };
  const adb = {
    getAndroidApiLevel: async (): Promise<number | null> => {
      timer.advanceTime(primaryElapsedMs);
      return null;
    },
    executeCommand: async (_command: string, timeoutMs?: number): Promise<ExecResult> => {
      probe.fallbackCalls += 1;
      probe.fallbackTimeoutMs = timeoutMs;
      return ok(fallbackStdout);
    },
  } as unknown as AdbExecutor;
  return { adb, probe };
}

describe("readAndroidDeviceApiLevel budget accounting", () => {
  test("charges the fallback the REMAINING budget after the primary probe, not a fresh one", async () => {
    const timer = new FakeTimer();
    // Primary consumes 60ms of a 100ms budget before returning null.
    const { adb, probe } = budgetProbe(timer, 60, "29");

    const level = await readAndroidDeviceApiLevel(adb, 100, timer);

    expect(level).toBe(29);
    // 100 - 60 = 40ms left; the fallback is bounded by that, never the full 100.
    expect(probe.fallbackTimeoutMs).toBe(40);
  });

  test("SKIPS the fallback re-probe when the primary already spent the whole budget", async () => {
    const timer = new FakeTimer();
    // Primary times out having consumed the entire 100ms budget.
    const { adb, probe } = budgetProbe(timer, 100, "31");

    const level = await readAndroidDeviceApiLevel(adb, 100, timer);

    // Nothing left to spend: re-probing a device that just timed out would only
    // extend the queue hold, so the fallback is not attempted at all.
    expect(level).toBeNull();
    expect(probe.fallbackCalls).toBe(0);
  });

  test("still runs the fallback with the full budget when the primary returned null instantly", async () => {
    const timer = new FakeTimer();
    // A stored-null executor (e.g. FakeAdbExecutor) answers instantly, spending
    // no budget; the fallback getprop is the first real probe and gets it all.
    const { adb, probe } = budgetProbe(timer, 0, "33");

    const level = await readAndroidDeviceApiLevel(adb, 100, timer);

    expect(level).toBe(33);
    expect(probe.fallbackCalls).toBe(1);
    expect(probe.fallbackTimeoutMs).toBe(100);
  });

  test("leaves the fallback unbounded when no budget was supplied", async () => {
    const timer = new FakeTimer();
    const { adb, probe } = budgetProbe(timer, 0, "30");

    const level = await readAndroidDeviceApiLevel(adb, undefined, timer);

    expect(level).toBe(30);
    expect(probe.fallbackCalls).toBe(1);
    // No deadline threaded: the fallback keeps its historical unbounded behavior
    // for callers that never opted into a budget.
    expect(probe.fallbackTimeoutMs).toBeUndefined();
  });
});
