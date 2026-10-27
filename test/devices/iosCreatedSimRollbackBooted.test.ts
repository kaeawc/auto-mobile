import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import {
  resetDeviceCreationGate,
  setDeviceCreationGate,
} from "../../src/devices/deviceCreationGate";
import { logger } from "../../src/utils/logger";
import type { DeviceClientSimctl } from "../../src/daemon/readiness/DeviceReadiness";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { SimulatorStillShuttingDownError } from "../../src/utils/ios-cmdline-tools/SimulatorStillShuttingDownError";

const CREATED = "ROLLBACK-CREATED-UDID";
const EXISTING = "ROLLBACK-EXISTING-UDID";

interface SimState {
  /** UDID -> simctl state of every simulator that exists. */
  sims: Map<string, "Booted" | "Shutdown">;
  calls: string[];
  shutdownTimeoutMs?: number;
  deleteTimeoutMs?: number;
  /** Leave the created simulator listed after a successful delete. */
  ghostAfterDelete?: boolean;
  shutdownError?: Error;
  deleteError?: Error;
  /** Make boot fail instead of reaching Booted. */
  bootError?: Error;
}

function newState(): SimState {
  return { sims: new Map(), calls: [] };
}

/**
 * Stateful simctl fake: delete rejects a running device, and shutdown of a
 * stopped device reports the same state-machine 405 as the real client.
 */
function statefulSimctl(state: SimState): DeviceClientSimctl {
  const listed = (): DeviceInfo[] =>
    [...state.sims].map(([deviceId, simState]) => ({
      name: "iPhone 17",
      platform: "ios",
      isRunning: simState === "Booted",
      deviceId,
      state: simState,
      isAvailable: true,
    }));
  return {
    ...fakeDeviceManagerSimctl(),
    listSimulatorImages: async () => listed(),
    getBootedSimulators: async () => [],
    getBootedSimulatorsChecked: async () => [],
    getDeviceTypes: async () => [
      {
        name: "iPhone 17",
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        productFamily: "iPhone",
        bundlePath: "/tmp",
        minRuntimeVersion: 0,
        maxRuntimeVersion: 0,
      },
    ],
    resolveRuntimeIdentifiersForBounds: async () => ["com.apple.CoreSimulator.SimRuntime.iOS-26-3"],
    createSimulator: async () => {
      state.sims.set(CREATED, "Shutdown");
      return CREATED;
    },
    bootSimulator: async (udid: string): Promise<BootedDevice> => {
      state.calls.push(`boot ${udid}`);
      if (state.bootError) {
        throw state.bootError;
      }
      state.sims.set(udid, "Booted");
      return { deviceId: udid, name: "AutoMobile-iPhone-17", platform: "ios" };
    },
    presentSimulatorAfterStart: async () => {},
    killSimulator: async (device: BootedDevice, options) => {
      state.calls.push(`shutdown ${device.deviceId}`);
      state.shutdownTimeoutMs = options?.timeoutMs;
      if (state.shutdownError) {
        throw state.shutdownError;
      }
      if (state.sims.get(device.deviceId) !== "Booted") {
        throw new Error(
          "Unable to shutdown device in current state: Shutdown (domain=com.apple.CoreSimulator.SimError, code=405)",
        );
      }
      state.sims.set(device.deviceId, "Shutdown");
    },
    deleteSimulator: async (udid: string, options) => {
      state.calls.push(`delete ${udid}`);
      state.deleteTimeoutMs = options?.timeoutMs;
      if (state.deleteError) {
        throw state.deleteError;
      }
      if (state.sims.get(udid) === "Booted") {
        throw new Error(
          "Unable to delete device in current state: Booted (domain=com.apple.CoreSimulator.SimError, code=405)",
        );
      }
      if (!state.ghostAfterDelete) {
        state.sims.delete(udid);
      }
    },
    // The post-boot readiness check fails (runner never became ready).
    getDeviceInfo: async () => {
      throw new Error("runner readiness failed");
    },
  };
}

function makeManager(state: SimState, runner: FakeIOSCtrlProxyManager, timer = new FakeTimer()) {
  const stop = runner.stop.bind(runner);
  runner.stop = async () => {
    state.calls.push("runner-stop");
    await stop();
  };
  const adb = new FakeAdbExecutor();
  return DeviceReadiness.createInstance(
    new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), statefulSimctl(state), {
      iosCtrlProxyManager: runner,
    }),
    { create: () => adb },
    { runnerReadinessTimer: timer },
  );
}

describe("findOrStartIosDevice rollback of a created simulator", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetDeviceCreationGate();
    warn.mockRestore();
  });

  const warnings = (): string[] => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  test("retires the runner, shuts the booted simulator down, deletes it and verifies absence", async () => {
    const state = newState();
    const manager = makeManager(state, new FakeIOSCtrlProxyManager());

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");

    expect(state.calls).toEqual([
      `boot ${CREATED}`,
      "runner-stop",
      `shutdown ${CREATED}`,
      `delete ${CREATED}`,
    ]);
    expect(state.sims.has(CREATED)).toBe(false);
    expect(state.shutdownTimeoutMs).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(state.deleteTimeoutMs).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(warnings().some((message) => message.includes("may be left behind"))).toBe(false);
  });

  test("a created simulator that never booted needs no shutdown, only delete and verify", async () => {
    const state = newState();
    state.bootError = new Error("boot refused");
    const manager = makeManager(state, new FakeIOSCtrlProxyManager());

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("boot refused");

    // The tolerated "current state: Shutdown" answer does not stop the delete.
    expect(state.calls).toContain(`delete ${CREATED}`);
    expect(state.sims.has(CREATED)).toBe(false);
    expect(warnings().some((message) => message.includes("may be left behind"))).toBe(false);
  });

  test.each([
    new Error("simctl shutdown timed out"),
    new SimulatorStillShuttingDownError(CREATED, "Created simulator", "Shutting Down", 10_000),
  ])(
    "a failed shutdown attempts delete and warns when Booted prevents deletion: %s",
    async (shutdownError) => {
      const state = newState();
      state.shutdownError = shutdownError;
      const manager = makeManager(state, new FakeIOSCtrlProxyManager());

      await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");

      expect(state.calls).toContain(`delete ${CREATED}`);
      expect(state.sims.get(CREATED)).toBe("Booted");
      const warning = warnings().find((message) => message.includes("attempting delete"));
      expect(warning).toContain(CREATED);
      expect(warning).toContain(shutdownError.message);
      const leftover = warnings().find((message) => message.includes("may be left behind"));
      expect(leftover).toContain("state: Booted");
      expect(leftover).toContain("Unable to delete device in current state: Booted");
    },
  );

  test("a shutdown failure followed by a delete failure still reports the leftover state", async () => {
    const state = newState();
    state.shutdownError = new Error("simctl shutdown timed out");
    state.deleteError = new Error("delete failed too");
    const manager = makeManager(state, new FakeIOSCtrlProxyManager());
    await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");
    expect(state.calls).toContain(`delete ${CREATED}`);
    const leftover = warnings().find((message) => message.includes("may be left behind"));
    expect(leftover).toContain("state: Booted");
    expect(leftover).toContain("delete failed too");
  });

  test("a failed delete surfaces the original error and warns with the leftover state", async () => {
    const state = newState();
    state.deleteError = new Error("delete wedged");
    const manager = makeManager(state, new FakeIOSCtrlProxyManager());

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");

    const leftover = warnings().find((message) => message.includes("may be left behind"));
    expect(leftover).toContain(CREATED);
    expect(leftover).toContain("state: Shutdown");
    expect(leftover).toContain("delete wedged");
  });

  test("a simulator still listed after delete is reported as left behind", async () => {
    const state = newState();
    state.ghostAfterDelete = true;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = makeManager(state, new FakeIOSCtrlProxyManager(), timer);

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");

    const leftover = warnings().find((message) => message.includes("may be left behind"));
    expect(leftover).toContain("still listed after delete");
    expect(leftover).toContain(CREATED);
  });

  test("a runner that fails to stop is logged and the rollback still completes", async () => {
    const state = newState();
    const runner = new FakeIOSCtrlProxyManager();
    runner.setStopShouldFail(true);
    const manager = makeManager(state, runner);

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("runner readiness failed");

    expect(state.sims.has(CREATED)).toBe(false);
    expect(warnings().some((message) => message.includes("Failed to stop CtrlProxy iOS"))).toBe(
      true,
    );
  });

  test("never shuts down or deletes a pre-existing simulator", async () => {
    const state = newState();
    state.sims.set(EXISTING, "Shutdown");
    const manager = makeManager(state, new FakeIOSCtrlProxyManager());

    await expect(manager.findOrStartIosDevice()).rejects.toThrow();

    expect(state.calls.some((call) => call.startsWith("delete "))).toBe(false);
    expect(state.calls.some((call) => call.startsWith("shutdown "))).toBe(false);
    expect(state.sims.has(EXISTING)).toBe(true);
  });
});
