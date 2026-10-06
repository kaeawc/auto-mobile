import { describe, expect, test } from "bun:test";
import { resolveIosDowngradeRecoveryBackend } from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { SIMULATOR_UNINSTALL_TIMEOUT_MS } from "../../../src/utils/ios-cmdline-tools/simulatorUninstallBound";
import { ActionableError } from "../../../src/models/ActionableError";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import type { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";

type SimctlOptions = { timeoutMs?: number; signal?: AbortSignal } | undefined;
type RecoverySimctl = Pick<SimCtlClient, "terminateApp" | "uninstallApp">;

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const bundleId = "com.example.app";

function fakeSimctl(onUninstall?: (options: SimctlOptions) => Promise<void>) {
  const calls: Array<{ method: string; deviceId?: string; options: SimctlOptions }> = [];
  const simctl: RecoverySimctl = {
    terminateApp: async (_bundle, deviceId, options) => {
      calls.push({ method: "terminateApp", deviceId, options });
    },
    uninstallApp: async (_bundle, deviceId, options) => {
      calls.push({ method: "uninstallApp", deviceId, options });
      await onUninstall?.(options);
    },
  };
  return { simctl, calls };
}

function recoveryBackend(simctl: RecoverySimctl) {
  const backend = resolveIosDowngradeRecoveryBackend(simulatorUdid, { simctl });
  if (!backend) {
    throw new Error("expected a simulator recovery backend");
  }
  return backend;
}

describe("iOS downgrade recovery backend uninstall (#10077 treatment for #10072 recovery)", () => {
  test("bounds the uninstall with the simulator uninstall budget and forwards the signal", async () => {
    const { simctl, calls } = fakeSimctl();
    const controller = new AbortController();

    await recoveryBackend(simctl).uninstallApp(bundleId, controller.signal);

    expect(calls).toEqual([
      {
        method: "uninstallApp",
        deviceId: simulatorUdid,
        options: { timeoutMs: SIMULATOR_UNINSTALL_TIMEOUT_MS, signal: controller.signal },
      },
    ]);
  });

  test("bounds the best-effort terminate too", async () => {
    const { simctl, calls } = fakeSimctl();

    await recoveryBackend(simctl).terminateApp(bundleId);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.options?.timeoutMs).toBeLessThan(SIMULATOR_UNINSTALL_TIMEOUT_MS);
  });

  test("an uninstall with no cancellation in scope carries a bound and no signal", async () => {
    const { simctl, calls } = fakeSimctl();

    await recoveryBackend(simctl).uninstallApp(bundleId);

    expect(calls[0]?.options).toEqual({ timeoutMs: SIMULATOR_UNINSTALL_TIMEOUT_MS });
  });

  test.each(["explicit", "ambient"] as const)(
    "a %s cancellation seen before dispatch leaves the app installed",
    async (source) => {
      const { simctl, calls } = fakeSimctl();
      const controller = new AbortController();
      controller.abort();

      const run = runWithAbortSignal(source === "ambient" ? controller.signal : undefined, () =>
        recoveryBackend(simctl).uninstallApp(
          bundleId,
          source === "explicit" ? controller.signal : undefined,
        ),
      );

      await expect(run).rejects.toThrow("Operation cancelled");
      expect(calls).toEqual([]);
    },
  );

  test("the ambient request signal reaches the uninstall so it can be killed", async () => {
    const { simctl, calls } = fakeSimctl();
    const controller = new AbortController();

    await runWithAbortSignal(controller.signal, () =>
      recoveryBackend(simctl).uninstallApp(bundleId),
    );

    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  test("a cancellation that kills the dispatched uninstall propagates as a cancellation", async () => {
    const controller = new AbortController();
    const { simctl } = fakeSimctl(async () => {
      controller.abort();
      throw new Error("simctl uninstall killed");
    });

    const run = recoveryBackend(simctl).uninstallApp(bundleId, controller.signal);

    await expect(run).rejects.toThrow("Operation cancelled");
  });

  test("a timed-out uninstall is reported as indeterminate, not as a plain failure", async () => {
    const timeout = new SimctlCommandTimeoutError("Command timed out after 30000ms");
    const { simctl } = fakeSimctl(async () => {
      throw timeout;
    });

    const failure = await recoveryBackend(simctl)
      .uninstallApp(bundleId)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ActionableError);
    const { message, cause } = failure as ActionableError;
    expect(message).toContain("Uninstall outcome is indeterminate");
    expect(message).toContain(bundleId);
    expect(message).toContain("Do not retry automatically");
    expect(cause).toBe(timeout);
  });

  test("a definitive uninstall failure is rethrown unchanged", async () => {
    const failure = new Error("Unable to uninstall: no such app");
    const { simctl } = fakeSimctl(async () => {
      throw failure;
    });

    await expect(recoveryBackend(simctl).uninstallApp(bundleId)).rejects.toBe(failure);
  });

  test("physical devices have no simctl recovery backend", () => {
    const { simctl } = fakeSimctl();

    expect(resolveIosDowngradeRecoveryBackend("00008101-001A2B3C4D5E6F78", { simctl })).toBeNull();
  });
});
