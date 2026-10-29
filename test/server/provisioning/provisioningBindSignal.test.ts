import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import type { DeviceBootResult } from "../../../src/devices/deviceBootService";
import type { DeviceInfo } from "../../../src/models";
import { bindProvisionedDeviceSession } from "../../../src/server/provisioning/provisioningSession";
import type { ProvisioningContext } from "../../../src/server/provisioning/provisioningTypes";
import { FakeTimer } from "../../fakes/FakeTimer";

// provisionDevice hands its bind the deadline-bound request signal explicitly (#15671): the
// autolock path below it no longer reads the ambient abort signal.

const args = {
  device: { platform: "android", name: "Pixel_9" },
  timeoutMs: 1000,
} as ProvisionDeviceArgs;
const boot: DeviceBootResult = {
  device: { platform: "android", name: "Pixel_9", deviceId: "emulator-5554" },
  source: "booted",
  provisioned: false,
};
const sourceImage: DeviceInfo = { platform: "android", name: "Pixel_9", isRunning: true };

type BindOptions = Parameters<ProvisioningContext["bindBootedDeviceSession"]>[4];

function contextRecording(bind: (options: BindOptions) => Promise<string>): ProvisioningContext {
  const unused = async (): Promise<never> => {
    throw new Error("not used by the session bind");
  };
  return {
    bindBootedDeviceSession: async (_d, _a, _s, _c, options) => await bind(options),
    ensureCtrlProxyReady: unused,
    executeDeleteDevice: unused,
  };
}

function bindWith(ctx: ProvisioningContext, signal: AbortSignal) {
  const timer = new FakeTimer();
  return bindProvisionedDeviceSession(ctx, args, boot, sourceImage, {
    timer,
    totalDeadlineMs: timer.now() + 1000,
    signal,
    readinessReservation: undefined,
    settlementState: { bindingSettlements: [] },
  });
}

describe("bindProvisionedDeviceSession signal threading", () => {
  test("a cancel mid-bind reaches the session bind and stops its work", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let bindSignal: AbortSignal | undefined;
    let stoppedWith: unknown;
    const ctx = contextRecording(async (options) => {
      bindSignal = options.signal;
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          stoppedWith = options.signal?.reason;
          reject(options.signal?.reason);
        });
      });
      return "unreachable";
    });

    const result = bindWith(ctx, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    expect(bindSignal?.aborted).toBe(false);
    const reason = new Error("provision cancelled");
    controller.abort(reason);

    expect(await result).toBe(reason);
    expect(stoppedWith).toBe(reason);
  });

  test("an uncancelled bind completes with its signal still live", async () => {
    let bindSignal: AbortSignal | undefined;
    const ctx = contextRecording(async (options) => {
      bindSignal = options.signal;
      return "session-1";
    });

    expect(await bindWith(ctx, new AbortController().signal)).toBe("session-1");
    expect(bindSignal).toBeInstanceOf(AbortSignal);
    expect(bindSignal?.aborted).toBe(false);
  });
});
