import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../src/utils/logger";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  registerDeviceTools,
  startDeviceSchema,
} from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeDeviceProvisioner } from "../fakes/FakeDeviceProvisioner";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { ProvisionDeviceCreateRejectedError } from "../../src/devices/exactDeviceProvisioning";

import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";

isolateToolRegistry();

describe("startDevice --create-if-missing wiring", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeMatcher: FakeDeviceMatcher;
  let fakeGate: FakeDeviceCreationGate;
  let fakeProvisioner: FakeDeviceProvisioner;
  let sessionManager: SessionManager;

  beforeEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeMatcher = new FakeDeviceMatcher();
    fakeGate = new FakeDeviceCreationGate(false);
    fakeProvisioner = new FakeDeviceProvisioner();

    // Nothing booted, nothing to match: every run reaches the "no match" branch.
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", []);
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", []);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(null);

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      deviceCreationGateFactory: () => fakeGate,
      deviceProvisionerFactory: () => fakeProvisioner,
    });

    const timer = new FakeTimer();
    const idGenerator = new CountingIdGenerator("creation-test");
    setDeviceToolsDependencies({ timer, idGenerator });
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setDeviceManager(fakeDeviceUtils);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "creation-test-daemon", {
        timer,
        idGenerator,
        deviceManager: fakeDeviceUtils,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    // Assignment rechecks iOS liveness through the POOL's manager, independently
    // of the tool's discovery manager. FakeDeviceUtils records booted creations.
    DaemonState.getInstance().initialize(
      sessionManager,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    resetVideoRecordingManagerDependencies();
  });

  async function callStartDevice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {
      throw new Error("startDevice not registered");
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }

  it("accepts createIfMissing through the tool schema", () => {
    const parsed = startDeviceSchema.parse({ platform: "ios", createIfMissing: true });
    expect((parsed as Record<string, unknown>).createIfMissing).toBe(true);
  });

  it("does NOT create anything when the gate is off (default)", async () => {
    await expect(callStartDevice({ platform: "ios" })).rejects.toThrow(
      /No ios device matching criteria found/,
    );
    expect(fakeProvisioner.requests).toEqual([]);
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("startDevice:")),
    ).toBe(false);
  });

  it("does NOT create anything when the flag is explicitly false", async () => {
    await expect(callStartDevice({ platform: "ios", createIfMissing: false })).rejects.toThrow(
      /No ios device matching criteria found/,
    );
    expect(fakeProvisioner.requests).toEqual([]);
    // The handler forwards the explicit flag to the gate so precedence is decided there.
    expect(fakeGate.calls).toEqual([false]);
  });

  it("creates and boots an iOS simulator when the gate is on", async () => {
    fakeGate.setAllowed(true);

    const result = await callStartDevice({ platform: "ios", createIfMissing: true });

    expect(fakeProvisioner.requests).toHaveLength(1);
    expect(fakeProvisioner.requests[0].platform).toBe("ios");
    expect(fakeGate.calls).toEqual([true]);
    expect(result.name).toBe("AutoMobile-iPhone-17-abcd1234");
    expect(result.runtime.deviceId).toBe("CREATED-UDID");
    expect(result.acquisition).toBe("cold-boot");
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("startDevice:")),
    ).toBe(true);
  });

  it("creates an Android AVD when the gate is on", async () => {
    fakeGate.setAllowed(true);
    fakeProvisioner.setResult({
      platform: "android",
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    });

    const result = await callStartDevice({ platform: "android", createIfMissing: true });

    expect(fakeProvisioner.requests[0].platform).toBe("android");
    expect(result.name).toBe("AutoMobile-android-34-abcd1234");
    expect(result.acquisition).toBe("cold-boot");
  });

  it("forwards the matching criteria to the provisioner", async () => {
    fakeGate.setAllowed(true);

    await callStartDevice({
      platform: "ios",
      createIfMissing: true,
      minOsVersion: "26.0",
      formFactor: "tablet",
      name: "iPad Pro 13-inch (M4)",
    });

    expect(fakeProvisioner.requests[0]).toMatchObject({
      platform: "ios",
      minOsVersion: "26.0",
      formFactor: "tablet",
      name: "iPad Pro 13-inch (M4)",
    });
  });

  it("consults the gate with undefined when the flag is not supplied (env var can decide)", async () => {
    fakeGate.setAllowed(true);

    await callStartDevice({ platform: "ios" });

    expect(
      fakeDeviceUtils.getBootedDevicesDetailedCalls().some((call) => call.platform === "ios"),
    ).toBe(true);
    expect(fakeGate.calls).toEqual([undefined]);
    expect(fakeProvisioner.requests).toHaveLength(1);
  });
  /** Teardown dependencies the rollback reaches; without them it falls through to real I/O. */
  async function useFakeTeardown(platform: "android" | "ios"): Promise<void> {
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      clearInstalledAppsForDevice: async () => {},
    });
    stopKilledDevices(platform);
  }

  function stopKilledDevices(platform: "android" | "ios"): void {
    const originalKillDevice = fakeDeviceUtils.killDevice.bind(fakeDeviceUtils);
    fakeDeviceUtils.killDevice = async (device) => {
      await originalKillDevice(device);
      fakeDeviceUtils.setBootedDevices(platform, []);
    };
  }

  it("deletes the AVD it created when the cold boot fails (#11100)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("android", [
            { name: created.name, platform: "android", isRunning: false },
          ]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
    });
    fakeDeviceUtils.setWaitForDeviceReadyError(new Error("emulator never became ready"));
    await useFakeTeardown("android");

    await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
      /emulator never became ready/,
    );

    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `destroyDevice:android:${created.name}`,
    );
    expect(await fakeDeviceUtils.listDeviceImages("android")).toEqual([]);
  });

  it("deletes the AVD it created when runner readiness fails after boot (#11155)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("android", [
            { name: created.name, platform: "android", isRunning: false },
          ]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("CtrlProxy install failed");
      },
    });
    await useFakeTeardown("android");

    await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
      /CtrlProxy install failed/,
    );

    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `destroyDevice:android:${created.name}`,
    );
    expect(await fakeDeviceUtils.listDeviceImages("android")).toEqual([]);
  });

  it("keeps readiness reservations until the created-device rollback settles (#11186)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("android", [
            { name: created.name, platform: "android", isRunning: false },
          ]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("CtrlProxy install failed");
      },
    });
    await useFakeTeardown("android");
    // Observe the pool's readiness reservation at the moment the AVD is deleted.
    const pool = DaemonState.getInstance().getDevicePool() as unknown as {
      isReservedForReadiness(deviceId: string): boolean;
    };
    const reservedDuringRollback: boolean[] = [];
    const reservedIds: string[] = [];
    const reserve = DaemonState.getInstance().getDevicePool().reserveDeviceForReadiness;
    DaemonState.getInstance().getDevicePool().reserveDeviceForReadiness = function (
      this: unknown,
      deviceId,
      ...rest
    ) {
      reservedIds.push(deviceId);
      return reserve.call(this, deviceId, ...rest);
    };
    const originalDestroy = fakeDeviceUtils.destroyDevice.bind(fakeDeviceUtils);
    fakeDeviceUtils.destroyDevice = async (device, options) => {
      reservedDuringRollback.push(reservedIds.some((id) => pool.isReservedForReadiness(id)));
      await originalDestroy(device, options);
    };

    await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
      /CtrlProxy install failed/,
    );

    expect(reservedDuringRollback).toEqual([true]);
  });

  it("deletes the simulator it created when runner readiness fails after boot (#11155)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "ios" as const,
      name: "AutoMobile-iPhone-17-abcd1234",
      deviceId: "CREATED-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("ios", [{ ...created, isRunning: false }]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("XCTestRunner never became ready");
      },
    });
    await useFakeTeardown("ios");

    await expect(callStartDevice({ platform: "ios", createIfMissing: true })).rejects.toThrow(
      /XCTestRunner never became ready/,
    );

    expect(fakeDeviceUtils.getExecutedOperations()).toContain("destroyDevice:ios:CREATED-UDID");
    expect(await fakeDeviceUtils.listDeviceImages("ios")).toEqual([]);
  });

  it("logs the createIfMissing rollback with device id, reason and outcome at info (#11205)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "ios" as const,
      name: "AutoMobile-iPhone-17-feed1234",
      deviceId: "ROLLED-BACK-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("ios", [{ ...created, isRunning: false }]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("XCTestRunner never became ready");
      },
    });
    await useFakeTeardown("ios");
    const info = spyOn(logger, "info");
    try {
      await expect(callStartDevice({ platform: "ios", createIfMissing: true })).rejects.toThrow(
        /XCTestRunner never became ready/,
      );

      const rollbackLines = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("createIfMissing rollback"));
      expect(rollbackLines).toHaveLength(1);
      expect(rollbackLines[0]).toContain("id=ROLLED-BACK-UDID");
      expect(rollbackLines[0]).toContain("XCTestRunner never became ready");
      expect(rollbackLines[0]).toContain("outcome: succeeded");
    } finally {
      info.mockRestore();
    }
  });

  it("deletes the AVD a timed-out create left behind (#11155)", async () => {
    fakeGate.setAllowed(true);
    const claimed = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(claimed);
          // avdmanager wrote the AVD, then was killed at its timeout.
          fakeDeviceUtils.setDeviceImages("android", [
            { name: claimed.name, platform: "android", isRunning: false },
          ]);
          throw new Error("avdmanager command timed out after 300000ms");
        },
      }),
    });
    await useFakeTeardown("android");

    await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
      /avdmanager command timed out/,
    );

    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `destroyDevice:android:${claimed.name}`,
    );
    expect(await fakeDeviceUtils.listDeviceImages("android")).toEqual([]);
  });

  it("does not delete the requested AVD name when avdmanager rejected the create (#11155)", async () => {
    fakeGate.setAllowed(true);
    const claimed = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(claimed);
          fakeDeviceUtils.setDeviceImages("android", [
            { name: claimed.name, platform: "android", isRunning: false },
          ]);
          throw new ProvisionDeviceCreateRejectedError("AVD creation failed: name in use");
        },
      }),
    });
    await useFakeTeardown("android");

    await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
      /name in use/,
    );

    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("destroyDevice:")),
    ).toBe(false);
  });

  it("finds and deletes the simulator a cancelled create left behind (#11155)", async () => {
    fakeGate.setAllowed(true);
    const claimed = {
      platform: "ios" as const,
      name: "AutoMobile-iPhone-17-abcd1234",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(claimed);
          // simctl created it, but the create was cancelled before its UDID was read.
          fakeDeviceUtils.setDeviceImages("ios", [
            {
              ...claimed,
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
              deviceId: "SAME-NAME-OTHER-TYPE",
              isRunning: false,
            },
            { ...claimed, deviceId: "ORPHANED-UDID", isRunning: false },
          ]);
          throw new Error("simctl create cancelled");
        },
      }),
    });
    await useFakeTeardown("ios");

    await expect(callStartDevice({ platform: "ios", createIfMissing: true })).rejects.toThrow(
      /simctl create cancelled/,
    );

    const destroyed = fakeDeviceUtils
      .getExecutedOperations()
      .filter((op) => op.startsWith("destroyDevice:"));
    expect(destroyed).toEqual(["destroyDevice:ios:ORPHANED-UDID"]);
  });

  it("deletes the simulator it created when its boot fails (#11100)", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "ios" as const,
      name: "AutoMobile-iPhone-17-abcd1234",
      deviceId: "CREATED-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    };
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("ios", [{ ...created, isRunning: false }]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
    });
    fakeDeviceUtils.setWaitForDeviceReadyError(new Error("simulator never became ready"));
    await useFakeTeardown("ios");

    await expect(callStartDevice({ platform: "ios", createIfMissing: true })).rejects.toThrow(
      /simulator never became ready/,
    );

    expect(fakeDeviceUtils.getExecutedOperations()).toContain("destroyDevice:ios:CREATED-UDID");
    expect(await fakeDeviceUtils.listDeviceImages("ios")).toEqual([]);
  });
});
