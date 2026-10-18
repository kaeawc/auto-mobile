import { describe, expect, test } from "bun:test";
import {
  AndroidServiceReadinessVerifier,
  VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT,
} from "../../../../src/features/observe/android/AndroidServiceReadinessVerifier";
import type { HierarchySyncDiagnostics } from "../../../../src/features/observe/android/types";
import type { AccessibilityHierarchy } from "../../../../src/features/observe/android/types";
import { DefaultRetryExecutor } from "../../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

type Attempt = { runnerError?: string; hierarchy?: boolean };

function harness(script: Attempt[]) {
  const timer = new FakeTimer();
  const warnings: string[] = [];
  const calls: { timeoutMs: number }[] = [];
  const verifier = new AndroidServiceReadinessVerifier({
    retryExecutor: new DefaultRetryExecutor(timer),
    logger: { warn: (message: string) => void warnings.push(message) },
    requestHierarchySync: async (_signal, timeoutMs, diagnostics: HierarchySyncDiagnostics) => {
      calls.push({ timeoutMs });
      const step = script[Math.min(calls.length, script.length) - 1];
      if (step.runnerError) {
        diagnostics.runnerError = step.runnerError;
      }
      return step.hierarchy ? { hierarchy: {} as AccessibilityHierarchy } : null;
    },
  });
  return { verifier, timer, warnings, calls };
}

async function run(h: ReturnType<typeof harness>, attempts: number, delayMs: number) {
  const promise = h.verifier.verifyServiceReady(attempts, delayMs, 123);
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    h.timer.advanceTime(delayMs);
  }
  return promise;
}

describe("AndroidServiceReadinessVerifier", () => {
  test("returns true on the first attempt that yields a hierarchy and forwards the timeout", async () => {
    const h = harness([{ hierarchy: true }]);
    expect(await run(h, 5, 500)).toBe(true);
    expect(h.calls).toEqual([{ timeoutMs: 123 }]);
    expect(h.warnings).toEqual([]);
  });

  test("retries a plain timeout and then succeeds", async () => {
    const h = harness([{}, { hierarchy: true }]);
    expect(await run(h, 5, 500)).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  test("warns once after exhausting attempts with no runner error", async () => {
    const h = harness([{}]);
    expect(await run(h, 3, 500)).toBe(false);
    expect(h.calls).toHaveLength(3);
    expect(h.warnings).toEqual(["[CTRL_PROXY] Service not ready after 3 verification attempts"]);
  });

  test("short-circuits on identical runner errors and attributes the last one", async () => {
    const h = harness([{ runnerError: "boom" }]);
    expect(await run(h, 5, 500)).toBe(false);
    expect(h.calls).toHaveLength(VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT);
    expect(h.warnings[0]).toContain(
      `2/5 verification attempts (short-circuited: identical runner error on ${VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT} consecutive attempts)`,
    );
    expect(h.warnings[0]).toContain("(last runner error: boom)");
  });

  test("a plain timeout between identical runner errors resets the streak", async () => {
    const h = harness([{ runnerError: "boom" }, {}, { runnerError: "boom" }, {}]);
    expect(await run(h, 4, 500)).toBe(false);
    expect(h.calls).toHaveLength(4);
    expect(h.warnings[0]).toContain("4 verification attempts");
    expect(h.warnings[0]).toContain("(last runner error: boom)");
  });
});
