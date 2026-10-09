import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { ActionableError, BootedDevice } from "../../src/models";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

let policyReads = 0;
const env = new Proxy<Record<string, string | undefined>>(
  {},
  {
    get(target, key, receiver) {
      if (key === "AUTOMOBILE_DEVICE_POOL_AUTOLOCK") {
        policyReads += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  },
);
function setAutolock(enabled: boolean): void {
  env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = enabled ? "1" : "0";
}

describe("ToolRegistry autolock session enforcement", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const androidB: BootedDevice = {
    name: "Pixel B",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const iosA: BootedDevice = {
    name: "iPhone A",
    deviceId: "ios-device-a",
    platform: "ios",
  };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let restorePipelineOverrides: (() => void) | undefined;

  const schema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  function registerTool(name: string, options: { deviceReadOnly?: boolean } = {}) {
    ToolRegistry.registerDeviceAware(name, name, schema, async () => ({ success: true }), options);
    const tool = ToolRegistry.getTool(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeDeviceSessionManager);
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
  });

  afterEach(() => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    setAutolock(false);
  });

  describe("held-device refusal under autolock (#10833)", () => {
    async function lockedPool() {
      const timer = new FakeTimer();
      daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const pool = new DevicePool(
        createDevicePoolDependencies(daemonSessionManager, "daemon", {
          env,
          timer,
          deviceManager: new FakeDeviceUtils(),
        }),
      );
      await pool.initializeWithDevices([androidA]);
      pool.getDevice(androidA.deviceId)!.autolockSessionId = "other-owner";
      DaemonState.getInstance().initialize(daemonSessionManager, pool);
      fakeDeviceSessionManager.setConnectedDevices([androidA]);
    }

    test("a non-owner mutating call is refused with the typed ownership code", async () => {
      setAutolock(true);
      await lockedPool();
      const tool = registerTool("mutateHeld");
      const error = await tool.handler({ deviceId: androidA.deviceId }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "device_owned_by_other_session" });
      // Refused before readiness acts on the holder's device.
      expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
    });

    test("a non-owner call with no deviceId that would land on the held device does no readiness", async () => {
      setAutolock(true);
      await lockedPool();
      const tool = registerTool("mutateHeldImplicit");
      const error = await tool.handler({ platform: "android" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "device_owned_by_other_session" });
      expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
    });

    test("a deviceReadOnly (watching) call on the held device is allowed", async () => {
      setAutolock(true);
      await lockedPool();
      const tool = registerTool("watchHeld", { deviceReadOnly: true });
      await expect(tool.handler({ deviceId: androidA.deviceId })).resolves.toBeDefined();
    });
  });

  for (const initiallyEnabled of [true, false]) {
    test(`keeps access policy ${initiallyEnabled} across discovery and refreshes next call`, async () => {
      setAutolock(initiallyEnabled);
      const timer = new FakeTimer();
      daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const deviceUtils = new FakeDeviceUtils();
      const pool = new DevicePool(
        createDevicePoolDependencies(daemonSessionManager, "daemon", {
          env,
          timer,
          deviceManager: deviceUtils,
        }),
      );
      await pool.initializeWithDevices([androidA]);
      pool.getDevice(androidA.deviceId)!.autolockSessionId = "other-owner";
      DaemonState.getInstance().initialize(daemonSessionManager, pool);
      fakeDeviceSessionManager.setConnectedDevices([androidA]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const ensureReady = fakeDeviceSessionManager.ensureDeviceReady.bind(fakeDeviceSessionManager);
      fakeDeviceSessionManager.ensureDeviceReady = async (...args) => {
        entered.resolve();
        await release.promise;
        return ensureReady(...args);
      };
      const tool = registerTool("snapshotAccess");
      policyReads = 0;
      const pending = tool.handler({ deviceId: androidA.deviceId });
      const first = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      // Enabled, the held device is refused before readiness (#10833); the flip then lands between
      // calls. Disabled, it lands mid-call, inside readiness.
      await Promise.race([entered.promise, first]);
      setAutolock(!initiallyEnabled);
      release.resolve();
      const outcome = await first;
      if (initiallyEnabled) {
        expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
        expect(outcome).toBeInstanceOf(ActionableError);
        expect(String(outcome)).toContain("held by another session");
      } else {
        expect(outcome).toBeUndefined();
      }
      expect(policyReads).toBe(1);
      const next = tool.handler({ deviceId: androidA.deviceId });
      if (initiallyEnabled) {
        await expect(next).resolves.toBeDefined();
      } else {
        await expect(next).rejects.toThrow("held by another session");
      }
      expect(policyReads).toBe(2);
    });
  }

  test("the always-on Android ambiguity guard takes precedence when autolock is on", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockMultiAndroid");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows the call when a sessionUuid is provided", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockWithSession");

    const response = await tool.handler({ platform: "android", sessionUuid: "session-123" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows the call when an explicit deviceId is provided", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockWithDeviceId");

    const response = await tool.handler({ platform: "android", deviceId: "emulator-5556" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("does not require sessionUuid when only one Android device exists", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA]);

    const tool = registerTool("autolockSingleAndroid");

    const response = await tool.handler({ platform: "android" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBe(1);
  });

  test("shares one cancellable device scan across untargeted resolution", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA]);
    const tool = registerTool("autolockCancellableSingleAndroid");
    const controller = new AbortController();

    const response = await tool.handler({ platform: "android" }, undefined, controller.signal);

    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBe(1);
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsSignals()).toEqual([
      controller.signal,
    ]);
  });

  test("an abort during device discovery prevents further scans", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA]);
    let finishScan!: (devices: BootedDevice[]) => void;
    fakeDeviceSessionManager.setDetectConnectedPlatformsHook(
      () => new Promise((resolve) => (finishScan = resolve)),
    );
    const tool = registerTool("autolockAbortedDeviceScan");
    const controller = new AbortController();

    const call = tool.handler({ platform: "android" }, undefined, controller.signal);
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBe(1);
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsSignals()).toEqual([
      controller.signal,
    ]);
    controller.abort();
    finishScan([androidA]);

    await expect(call).rejects.toThrow();
    expect(fakeDeviceSessionManager.getDetectConnectedPlatformsCallCount()).toBe(1);
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("requires an explicit target for multiple Android devices when autolock is disabled", async () => {
    setAutolock(false);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockDisabledMultiAndroid");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("keeps the broader autolock guard for mixed-platform ambiguity", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, iosA]);

    const tool = registerTool("autolockEitherPlatform");

    const ambiguousCall = tool.handler({});
    await expect(ambiguousCall).rejects.toBeInstanceOf(ActionableError);
    await expect(ambiguousCall).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("rejects mixed-platform ambiguity after a deviceId-only resolution", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, iosA]);
    const tool = registerTool("autolockAfterResolution");

    await tool.handler({ deviceId: androidA.deviceId });
    expect(fakeDeviceSessionManager.getSetCurrentDeviceCalls()).toEqual([androidA]);
    await expect(tool.handler({})).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("rejects ambiguity after the previously resolved device is removed", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, iosA]);
    const tool = registerTool("autolockAfterRemoval");

    await tool.handler({ deviceId: androidA.deviceId });
    fakeDeviceSessionManager.setConnectedDevices([androidB, iosA]);
    await expect(tool.handler({})).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("rejects same-platform ambiguity after a deviceId-only resolution", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    const tool = registerTool("autolockSamePlatformAfterResolution");

    await tool.handler({ platform: "android", deviceId: androidA.deviceId });
    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows the call when a device was pinned via setActiveDevice", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    fakeDeviceSessionManager.setCurrentDevice(androidA, "android");
    fakeDeviceSessionManager.setExplicitDevicePin(androidA);

    const tool = registerTool("autolockActiveDevice");

    const response = await tool.handler({ platform: "android" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("an explicit pin survives a later deviceId-only resolution", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    fakeDeviceSessionManager.setCurrentDevice(androidA, "android");
    fakeDeviceSessionManager.setExplicitDevicePin(androidA);
    const tool = registerTool("autolockPinnedAfterOtherDevice");

    await tool.handler({ platform: "android", deviceId: androidB.deviceId });
    expect(fakeDeviceSessionManager.getCurrentDevice()?.deviceId).toBe(androidB.deviceId);
    await tool.handler({ platform: "android" });
    expect(fakeDeviceSessionManager.getCurrentDevice()?.deviceId).toBe(androidA.deviceId);
  });

  test("a released explicit pin no longer exempts an untargeted call", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    fakeDeviceSessionManager.setCurrentDevice(androidA, "android");
    fakeDeviceSessionManager.setExplicitDevicePin(androidA);
    fakeDeviceSessionManager.clearExplicitDevicePin(androidA.deviceId);
    const tool = registerTool("autolockAfterRelease");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("a removed explicit pin is invalidated before the ambiguity checks", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidB, iosA]);
    fakeDeviceSessionManager.setCurrentDevice(androidA, "android");
    fakeDeviceSessionManager.setExplicitDevicePin(androidA);
    const tool = registerTool("autolockStalePin");

    await expect(tool.handler({})).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getExplicitDevicePin()).toBeUndefined();
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("keeps an iOS pin when simctl scan fails during autolock enforcement", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, iosA]);
    fakeDeviceSessionManager.setCurrentDevice(iosA, "ios");
    fakeDeviceSessionManager.setExplicitDevicePin(iosA);
    fakeDeviceSessionManager.setPlatformScanFailure("ios", true);
    const tool = registerTool("autolockFailedIosScanPin");

    await tool.handler({ platform: "ios" });

    expect(fakeDeviceSessionManager.getExplicitDevicePin()).toEqual(iosA);
  });

  test("resolves the autolock session from the MCP session when sessionUuid is omitted", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "daemon-session", {
        env,
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");

    let handledDevice: BootedDevice | undefined;
    let handledArgs: Record<string, unknown> | undefined;
    ToolRegistry.registerDeviceAware(
      "implicitAutolockSession",
      "implicitAutolockSession",
      schema,
      async (device, args) => {
        handledDevice = device;
        handledArgs = args;
        return { success: true };
      },
    );
    const tool = ToolRegistry.getTool("implicitAutolockSession")!;

    const response = await tool.handler({
      platform: "android",
      keepScreenAwake: false,
      __mcpSessionId: "mcp-session-1",
    });

    expect(response).toEqual({ success: true });
    expect(handledDevice?.deviceId).toBe(androidA.deviceId);
    expect(handledArgs?.sessionUuid).toBe(sessionId);
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("rejects an unknown session UUID before it can access an owned device", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "daemon-session", {
        env,
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    await pool.bindOrReuseDeviceSession("owner-session", androidA.deviceId, "android");
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    let handlerCalls = 0;
    ToolRegistry.registerDeviceAware(
      "unknownSessionUuid",
      "unknownSessionUuid",
      schema,
      async () => {
        handlerCalls += 1;
        return { success: true };
      },
    );
    const tool = ToolRegistry.getTool("unknownSessionUuid")!;

    for (const sessionUuid of ["banana", "00000000-0000-4000-8000-000000000000"]) {
      await expect(
        tool.handler({
          platform: "android",
          deviceId: androidA.deviceId,
          sessionUuid,
        }),
      ).rejects.toMatchObject({
        // The owned device refuses a non-holder before admission (#10698).
        code: "device_owned_by_other_session",
        message: expect.stringContaining(`Session ${sessionUuid} does not hold it`),
      });
      expect(daemonSessionManager.getSession(sessionUuid)).toBeNull();
    }
    expect(handlerCalls).toBe(0);
    expect(pool.getDevice(androidA.deviceId)?.sessionId).toBe("owner-session");
  });

  test("resolves the MCP autolock session when the provided deviceId belongs to it", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "daemon-session", {
        env,
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");

    let handledDevice: BootedDevice | undefined;
    let handledArgs: Record<string, unknown> | undefined;
    ToolRegistry.registerDeviceAware(
      "implicitAutolockWithDeviceId",
      "implicitAutolockWithDeviceId",
      schema,
      async (device, args) => {
        handledDevice = device;
        handledArgs = args;
        return { success: true };
      },
    );
    const tool = ToolRegistry.getTool("implicitAutolockWithDeviceId")!;

    const response = await tool.handler({
      platform: "android",
      deviceId: androidA.deviceId,
      __mcpSessionId: "mcp-session-1",
    });

    expect(response).toEqual({ success: true });
    expect(handledDevice?.deviceId).toBe(androidA.deviceId);
    expect(handledArgs?.sessionUuid).toBe(sessionId);
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("does not apply an MCP autolock session to a different provided deviceId", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "daemon-session", {
        env,
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");
    await pool.autolockDevice(androidB.deviceId, "android", "mcp-session-2");

    const tool = registerTool("implicitAutolockDifferentDeviceId");

    await expect(
      tool.handler({
        platform: "android",
        deviceId: androidB.deviceId,
        __mcpSessionId: "mcp-session-1",
      }),
    ).rejects.toThrow("device 'emulator-5556' is held by another session");
  });
});
