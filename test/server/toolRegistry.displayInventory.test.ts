import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../fakes/FakeDisplayInventoryProvider";
import { CachingDisplayInventoryProvider } from "../../src/devices/DisplayInventoryProvider";
import { stubCtrlProxySetup, type CtrlProxySetupStub } from "../helpers/stubCtrlProxySetup";
import type { DeviceSession } from "../../src/db/types";

const android: BootedDevice = {
  name: "Pixel Fold",
  deviceId: "emulator-5554",
  platform: "android",
};
const displays = {
  panels: [
    { key: "inner-physical", role: "inner" as const, sizePx: { width: 2000, height: 2200 } },
    { key: "cover-physical", role: "cover" as const, sizePx: { width: 1000, height: 2200 } },
  ],
  postures: ["closed" as const, "opened" as const],
};

describe("ToolRegistry display inventory resolution", () => {
  let originalManager: unknown;
  let originalRepository: unknown;
  let restoreInventory: () => void;
  let ctrlProxyStub: CtrlProxySetupStub;
  let sessionManager: SessionManager | undefined;
  let fakeManager: FakeDeviceSessionManager;

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeManager = new FakeDeviceSessionManager();
    originalManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    originalRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeManager);
    Reflect.set(ToolRegistry, "toolCallRepository", { recordToolCall: async () => {} });
    ctrlProxyStub = stubCtrlProxySetup();
  });

  afterEach(() => {
    restoreInventory?.();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalRepository);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    ctrlProxyStub.restore();
  });

  function registerProbe(): void {
    ToolRegistry.registerDeviceAware(
      "displayInventoryProbe",
      "Inspect resolved inventory",
      z.object({ sessionUuid: z.string().optional(), deviceId: z.string().optional() }),
      async (device) => ({
        displays: device.displays,
        hasDisplays: Object.hasOwn(device, "displays"),
      }),
      { deviceReadiness: "booted" },
    );
  }

  test("legacy Android device is hydrated before the handler", async () => {
    const provider = new FakeDisplayInventoryProvider(displays);
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({ displayInventory: provider });
    fakeManager.setConnectedDevices([android]);
    registerProbe();
    const result = await ToolRegistry.getTool("displayInventoryProbe")!.handler({
      deviceId: android.deviceId,
    });
    expect(result).toEqual({ displays, hasDisplays: true });
    expect(provider.calls).toBe(1);
  });

  test("a thrown inventory read leaves the tool call successful and unhydrated", async () => {
    let reads = 0;
    const source = {
      read: async () => {
        reads++;
        throw new Error("adb inventory unavailable");
      },
    };
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new CachingDisplayInventoryProvider(source, source, new FakeTimer()),
    });
    fakeManager.setConnectedDevices([android]);
    registerProbe();
    const probe = ToolRegistry.getTool("displayInventoryProbe")!;
    expect(await probe.handler({ deviceId: android.deviceId })).toEqual({
      displays: undefined,
      hasDisplays: false,
    });
    expect(reads).toBe(1);
  });

  test("a rejecting inventory provider cannot fail the tool call", async () => {
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: {
        hydrate: async () => {
          throw new Error("inventory provider failed");
        },
        invalidate: () => {},
      },
    });
    fakeManager.setConnectedDevices([android]);
    registerProbe();
    expect(
      await ToolRegistry.getTool("displayInventoryProbe")!.handler({ deviceId: android.deviceId }),
    ).toEqual({ displays: undefined, hasDisplays: false });
  });

  test("rediscovery of the same serial hits the hydrated cache", async () => {
    const source = new FakeDisplayInventorySource({ displays, degraded: false });
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new CachingDisplayInventoryProvider(source, source, new FakeTimer()),
    });
    fakeManager.setConnectedDevices([{ ...android, observedAt: 1 }]);
    registerProbe();
    const probe = ToolRegistry.getTool("displayInventoryProbe")!;
    expect(await probe.handler({ deviceId: android.deviceId })).toEqual({
      displays,
      hasDisplays: true,
    });
    fakeManager.setConnectedDevices([{ ...android, observedAt: 2 }]);
    expect(await probe.handler({ deviceId: android.deviceId })).toEqual({
      displays,
      hasDisplays: true,
    });
    expect(source.reads).toBe(1);
  });

  test("invalidation makes the same serial a cache miss", async () => {
    const source = new FakeDisplayInventorySource({ displays, degraded: false });
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({ displayInventory: provider });
    fakeManager.setConnectedDevices([android]);
    registerProbe();
    const probe = ToolRegistry.getTool("displayInventoryProbe")!;
    await probe.handler({ deviceId: android.deviceId });
    provider.invalidate(android.deviceId);
    await probe.handler({ deviceId: android.deviceId });
    expect(source.reads).toBe(2);
  });

  test("legacy iOS Duo receives its cover and inner panel inventory", async () => {
    const duo: BootedDevice = {
      name: "iPhone Duo",
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
    };
    const duoDisplays = {
      panels: [
        { key: "primary", role: "cover" as const, sizePx: { width: 1398, height: 2034 } },
        { key: "primary-1", role: "inner" as const, sizePx: { width: 2007, height: 2853 } },
      ],
      postures: ["closed" as const, "half_opened" as const, "opened" as const],
    };
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(duoDisplays),
    });
    fakeManager.setConnectedDevices([duo]);
    registerProbe();
    expect(
      await ToolRegistry.getTool("displayInventoryProbe")!.handler({ deviceId: duo.deviceId }),
    ).toEqual({
      displays: duoDisplays,
      hasDisplays: true,
    });
  });

  test("single-screen legacy device keeps displays absent", async () => {
    const provider = new FakeDisplayInventoryProvider();
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({ displayInventory: provider });
    fakeManager.setConnectedDevices([android]);
    registerProbe();
    const result = await ToolRegistry.getTool("displayInventoryProbe")!.handler({
      deviceId: android.deviceId,
    });
    expect(result).toEqual({ displays: undefined, hasDisplays: false });
  });

  test("single-screen legacy iOS device also keeps displays absent", async () => {
    const ios: BootedDevice = {
      name: "iPhone 17",
      platform: "ios",
      deviceId: "11111111-2222-3333-4444-555555555555",
    };
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    fakeManager.setConnectedDevices([ios]);
    registerProbe();
    expect(
      await ToolRegistry.getTool("displayInventoryProbe")!.handler({ deviceId: ios.deviceId }),
    ).toEqual({
      displays: undefined,
      hasDisplays: false,
    });
  });

  const sessionDevices: BootedDevice[] = [
    android,
    {
      name: "iPhone Duo",
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
    },
  ];

  for (const target of sessionDevices) {
    test(`persisted ${target.platform} session hydrates its pool-built device`, async () => {
      const inventory =
        target.platform === "android"
          ? displays
          : {
              panels: [
                { key: "primary", role: "cover" as const, sizePx: { width: 1398, height: 2034 } },
                { key: "primary-1", role: "inner" as const, sizePx: { width: 2007, height: 2853 } },
              ],
              postures: ["closed" as const, "half_opened" as const, "opened" as const],
            };
      const provider = new FakeDisplayInventoryProvider(inventory);
      restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: provider,
      });
      fakeManager.setConnectedDevices([target]);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const persisted: DeviceSession = {
        session_uuid: "display-session",
        device_id: target.deviceId,
        stable_device_id: target.platform === "ios" ? target.deviceId : target.name,
        platform: target.platform,
        status: "active",
        source: null,
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: null,
        release_reason: null,
        session_timeout_ms: 60_000,
        heartbeat_timeout_ms: 60_000,
        has_received_heartbeat: 1,
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z",
      };
      sessionManager = new SessionManager(timer, {
        getSession: async () => persisted,
        upsertActiveSession: async () => {},
        recordActivity: async () => {},
        markReleased: async () => {},
        markStaleActiveSessionsExpired: async () => {},
      });
      const deviceUtils = new FakeDeviceUtils();
      deviceUtils.setBootedDevices(target.platform, [target]);
      const pool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "new-daemon", {
          timer,
          deviceManager: deviceUtils,
        }),
      );
      await pool.initializeWithDevices([target]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      registerProbe();
      const result = await ToolRegistry.getTool("displayInventoryProbe")!.handler({
        sessionUuid: "display-session",
      });
      expect(result).toEqual({ displays: inventory, hasDisplays: true });
      const incarnation = pool.getDevice(target.deviceId)?.incarnation;
      expect(incarnation).toBeNumber();
      expect(provider.tokens).toEqual([`${incarnation}:${target.name}`]);
    });
  }
});
