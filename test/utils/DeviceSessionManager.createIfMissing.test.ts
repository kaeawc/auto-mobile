import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import {
  resetDeviceCreationGate,
  setDeviceCreationGate,
} from "../../src/devices/deviceCreationGate";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import type {
  IosBootInstrumentation,
  IosBootRequest,
} from "../../src/features/iosSimFleet/IosBootInstrumentation";

interface SimctlRecorder {
  createCalls: { name: string; deviceType: string; runtime: string }[];
  bootCalls: string[];
  presentationCalls: Array<{ udid: string; generation: string }>;
  presentationSignals: Array<AbortSignal | undefined>;
  deleteCalls?: string[];
  deleteSignalAborted?: boolean[];
  bootError?: Error;
  bootAbortController?: AbortController;
  verifyError?: Error;
}

/**
 * Minimal injected simctl fake. It never reaches a real simulator, and records
 * the creation and boot decisions made by findOrStartIosDevice.
 */
function makeSimctl(recorder: SimctlRecorder, simulatorImages: DeviceInfo[] = []): SimCtlClient {
  return {
    listSimulatorImages: async () => simulatorImages,
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
    createSimulator: async (name: string, deviceType: string, runtime: string) => {
      recorder.createCalls.push({ name, deviceType, runtime });
      return "CREATED-UDID";
    },
    bootSimulator: async (udid: string): Promise<BootedDevice> => {
      recorder.bootCalls.push(udid);
      recorder.bootAbortController?.abort();
      if (recorder.bootError) {
        throw recorder.bootError;
      }
      return { deviceId: udid, name: "AutoMobile-iPhone-17", platform: "ios" };
    },
    presentSimulatorAfterStart: async (udid: string, generation: string, signal?: AbortSignal) => {
      recorder.presentationCalls.push({ udid, generation });
      recorder.presentationSignals.push(signal);
    },
    deleteSimulator: async (udid: string, options?: { signal?: AbortSignal }) => {
      recorder.deleteCalls?.push(udid);
      recorder.deleteSignalAborted?.push(options?.signal?.aborted ?? false);
    },
    // verifyIosDevice returns early for a non-Booted, available device.
    getDeviceInfo: async () => {
      if (recorder.verifyError) {
        throw recorder.verifyError;
      }
      return {
        name: "AutoMobile-iPhone-17",
        isAvailable: true,
        state: "Shutdown",
      };
    },
  } as unknown as SimCtlClient;
}

function simulatorImage(
  deviceId: string,
  isAvailable: boolean,
  availabilityError?: string,
): DeviceInfo {
  return {
    name: `iPhone ${deviceId}`,
    platform: "ios",
    isRunning: false,
    deviceId,
    state: "Shutdown",
    isAvailable,
    availabilityError,
  };
}

describe("findOrStartIosDevice creation gate", () => {
  let recorder: SimctlRecorder;
  let manager: DeviceSessionManager;

  beforeEach(() => {
    recorder = {
      createCalls: [],
      bootCalls: [],
      presentationCalls: [],
      presentationSignals: [],
      deleteCalls: [],
      deleteSignalAborted: [],
    };
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder),
    );
    manager = new DeviceSessionManager(provider);
  });

  afterEach(() => {
    resetDeviceCreationGate();
  });

  test("keeps the existing error and creates nothing when the gate is off", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(false));

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(
      "No iOS simulators are available. Please create an iOS simulator using Xcode or the Simulator app.",
    );
    expect(recorder.createCalls).toEqual([]);
    expect(recorder.bootCalls).toEqual([]);
  });

  test("creates and boots a simulator when the gate is on", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    const device = await manager.findOrStartIosDevice();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.createCalls[0].deviceType).toBe(
      "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    );
    expect(recorder.createCalls[0].runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-26-3");
    expect(recorder.createCalls[0].name).toStartWith("AutoMobile-iPhone-17-");
    expect(recorder.bootCalls).toEqual(["CREATED-UDID"]);
    expect(recorder.presentationCalls).toHaveLength(1);
    expect(recorder.presentationCalls[0].udid).toBe("CREATED-UDID");
    expect(recorder.presentationSignals[0]).toBeInstanceOf(AbortSignal);
    expect(recorder.deleteCalls).toEqual([]);
    expect(device.deviceId).toBe("CREATED-UDID");
  });

  test("rolls back a created simulator when boot/verify fails after creation", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));
    recorder.bootError = new Error("boot failed");

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("boot failed");
    expect(recorder.deleteCalls).toEqual(["CREATED-UDID"]);
  });

  test("rolls back a created simulator when binding its lifecycle identity fails (#11100)", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    // Another operation owns the new UDID, so binding it must wait; the request
    // is cancelled while it waits, after simctl already created the simulator.
    const holder = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: "CREATED-UDID" },
      { operation: "start", deadlineMs: 60_000 },
    );
    const request = new AbortController();
    const simctl = makeSimctl(recorder);
    const createSimulator = simctl.createSimulator.bind(simctl);
    simctl.createSimulator = async (...args) => {
      const udid = await createSimulator(...args);
      queueMicrotask(() => request.abort(new Error("request cancelled")));
      return udid;
    };
    manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils(), simctl),
      undefined,
      { lifecycleCoordinator },
    );

    await expect(manager.findOrStartIosDevice({ signal: request.signal })).rejects.toThrow();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.bootCalls).toEqual([]);
    expect(recorder.deleteCalls).toEqual(["CREATED-UDID"]);
    expect(recorder.deleteSignalAborted).toEqual([false]);
    holder.release();
  });

  test("uses a live signal when rolling back after request cancellation", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));
    recorder.bootError = new DOMException("The operation was aborted.", "AbortError");
    const requestAbortController = new AbortController();
    recorder.bootAbortController = requestAbortController;

    await expect(
      runWithAbortSignal(requestAbortController.signal, () => manager.findOrStartIosDevice()),
    ).rejects.toThrow("Failed to boot/verify created iOS simulator");
    expect(recorder.deleteCalls).toEqual(["CREATED-UDID"]);
    expect(recorder.deleteSignalAborted).toEqual([false]);
  });

  test("does not delete an adopted existing simulator when boot/verify fails", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [simulatorImage("EXISTING-UDID", true)]),
    );
    manager = new DeviceSessionManager(provider);
    recorder.verifyError = new Error("verify failed");

    await expect(manager.findOrStartIosDevice()).rejects.toThrow("verify failed");
    expect(recorder.deleteCalls).toEqual([]);
  });

  test("consults the gate with no explicit flag (env var only on this path)", async () => {
    const gate = new FakeDeviceCreationGate(false);
    setDeviceCreationGate(gate);

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(/No iOS simulators are available/);
    expect(gate.calls).toEqual([undefined]);
  });

  test("boots an available simulator when an unavailable one sorts first", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [
        simulatorImage("000-unavailable", false, "runtime unavailable"),
        simulatorImage("999-available", true),
      ]),
    );
    manager = new DeviceSessionManager(provider);

    await manager.findOrStartIosDevice();

    expect(recorder.bootCalls).toEqual(["999-available"]);
    expect(recorder.presentationSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("provisions a replacement when every simulator image is unavailable and creation is enabled", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [simulatorImage("unavailable", false, "runtime unavailable")]),
    );
    manager = new DeviceSessionManager(provider);
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    await manager.findOrStartIosDevice();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.bootCalls).toEqual(["CREATED-UDID"]);
  });

  test("reports unavailable simulator diagnostics when creation is disabled", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [simulatorImage("unavailable", false, "runtime unavailable")]),
    );
    manager = new DeviceSessionManager(provider);
    setDeviceCreationGate(new FakeDeviceCreationGate(false));

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(
      "No available iOS simulators. Unavailable simulators: iPhone unavailable (unavailable): runtime unavailable.",
    );
    expect(recorder.createCalls).toEqual([]);
    expect(recorder.bootCalls).toEqual([]);
  });
});

/** Refuses every boot at the limit, the way the shared iOS admission gate does. */
class RefusingIosBootInstrumentation implements IosBootInstrumentation {
  readonly requests: IosBootRequest[] = [];

  async run<T>(request: IosBootRequest): Promise<T> {
    this.requests.push(request);
    throw new BootCapacityExhaustedError(
      { platform: "ios", limit: 1, booted: 1, retryAfterMs: 3_000 },
      "Refused to boot: no iOS simulator capacity",
    );
  }
}

// #11236: findOrStartIosDevice called simctl.bootSimulator directly, bypassing the
// iOS capacity gate every other simulator boot goes through.
describe("findOrStartIosDevice boot admission", () => {
  let recorder: SimctlRecorder;
  let instrumentation: RefusingIosBootInstrumentation;

  beforeEach(() => {
    recorder = {
      createCalls: [],
      bootCalls: [],
      presentationCalls: [],
      presentationSignals: [],
      deleteCalls: [],
      deleteSignalAborted: [],
    };
    instrumentation = new RefusingIosBootInstrumentation();
  });

  afterEach(() => {
    resetDeviceCreationGate();
  });

  const managerWith = (images: DeviceInfo[]) =>
    DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(
        new FakeAdbExecutor(),
        new FakeDeviceUtils(),
        makeSimctl(recorder, images),
      ),
      undefined,
      { iosBootInstrumentation: instrumentation },
    );

  test("refuses to boot an existing simulator at the limit", async () => {
    const error = await managerWith([simulatorImage("AAAA", true)])
      .findOrStartIosDevice()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(instrumentation.requests.map((request) => request.udid)).toEqual(["AAAA"]);
    expect(recorder.bootCalls).toEqual([]);
  });

  test("refuses to boot a created simulator at the limit and rolls it back", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    const error = await managerWith([])
      .findOrStartIosDevice()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(instrumentation.requests.map((request) => request.udid)).toEqual(["CREATED-UDID"]);
    expect(recorder.bootCalls).toEqual([]);
    expect(recorder.deleteCalls).toEqual(["CREATED-UDID"]);
  });
});
