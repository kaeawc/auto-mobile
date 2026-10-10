import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import {
  registerAppTools,
  resetListAppsToolDependencies,
  setListAppsToolDependencies,
} from "../../src/server/appTools";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { registerNetworkTools } from "../../src/server/networkTools";
import { registerPreferenceTools } from "../../src/server/preferenceTools";
import { registerSnapshotOfTools } from "../../src/server/snapshotOfTools";
import { registerStorageTools } from "../../src/server/storageTools";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { registerDeepLinkTools } from "../../src/server/deepLinkTools";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { registerNotificationTools } from "../../src/server/notificationTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { registerPrototypeTools } from "../../src/server/prototypeTools";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import type { DeviceObservationAccess } from "../../src/server/deviceObservationAccess";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { isSessionlessDeviceRead } from "../../src/features/toolSelection/toolSelectionContext";
import type { AppsQueryResourceContent } from "../../src/server/appResources";
import { serverConfig } from "../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../src/utils/debug";

/**
 * Read-only tools on a device another session holds (#10830). Watching is allowed on any device
 * (#10730), but a sessionless call used to ready its target through ensureDeviceReady (CtrlProxy
 * setup, the current-device pin, settings), so read tools were refused on a held device (#10828).
 * A sessionless read-only call that would land on a held device now runs through the read-only
 * device path: resolved from the booted list, with no readiness, no recording and no audit.
 */
describe("ToolRegistry read-only device path on a held device (#10830)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const agent = "agent-session";

  let audited: Array<{ name: string; deviceId: string }>;
  let recorded: string[];
  let reads: Array<{ deviceId: string; readPath: boolean; sessionUuid: unknown }>;
  let listed: number;
  let authorized: boolean;
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let devices: FakeDeviceSessionManager;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  async function outcome(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(name, args);
    } catch (error) {
      return error;
    }
  }

  function expectNoReadiness(): void {
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
  }

  beforeEach(async () => {
    audited = [];
    recorded = [];
    reads = [];
    listed = 0;
    authorized = true;
    ToolRegistry.clearTools();
    const deviceReadAccess: DeviceObservationAccess = {
      listBooted: async () => {
        listed++;
        return [held, free];
      },
      isAuthorized: () => authorized,
    };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess,
      auditRunner: {
        async run(input: AuditRunnerInput) {
          audited.push({ name: input.name, deviceId: input.device.deviceId });
          return { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    devices = new FakeDeviceSessionManager();
    devices.setConnectedDevices([held, free]);
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", {
      record: (name: string) => {
        recorded.push(name);
        return undefined;
      },
    });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [held, free]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "read-only-device-path", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(agent, held.deviceId, "android");
    sessionManager.setDeviceReadiness(agent, "automationReady");

    // A read-only probe whose handler records how it was reached.
    ToolRegistry.registerDeviceAware(
      "readProbe",
      "Read-only probe",
      z.object({}).passthrough(),
      async (device: BootedDevice, args: Record<string, unknown>) => {
        reads.push({
          deviceId: device.deviceId,
          readPath: isSessionlessDeviceRead(),
          sessionUuid: args.sessionUuid,
        });
        return { success: true };
      },
      { deviceReadOnly: true },
    );
  });

  afterEach(() => {
    serverConfig.setEmbeddedSdkEnabled(false);
    restorePipeline();
    resetListAppsToolDependencies();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", originalNavigationRecorder);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("a sessionless read with a held deviceId runs on the read-only path with no readiness", async () => {
    await call("readProbe", { platform: "android", deviceId: held.deviceId });

    expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
    expect(listed).toBe(1);
    expectNoReadiness();
    expect(audited).toEqual([]);
    expect(recorded).toEqual([]);
    expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
  });

  test("a sessionless read with no deviceId that would land on a held device watches it", async () => {
    devices.setConnectedDevices([held]);
    await call("readProbe", { platform: "android" });

    expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
    expectNoReadiness();
  });

  test("the holder's own read keeps its session path", async () => {
    await call("readProbe", { sessionUuid: agent, deviceId: held.deviceId });

    expect(listed).toBe(0);
    expect(audited).toEqual([{ name: "readProbe", deviceId: held.deviceId }]);
    expect(recorded).toEqual(["readProbe"]);
  });

  test("a sessionless read on an unheld device keeps the normal readiness path", async () => {
    await call("readProbe", { platform: "android", deviceId: free.deviceId });

    expect(listed).toBe(0);
    expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
    expect(audited).toEqual([{ name: "readProbe", deviceId: free.deviceId }]);
  });

  // #10968: the IDE injects its observer session UUID into every call. That UUID is not a device
  // session this daemon issued, so a read carrying it is sessionless rather than refused.
  test("a read naming an unissued (observer) session watches a held device sessionlessly", async () => {
    await call("readProbe", { sessionUuid: "observer-session", deviceId: held.deviceId });

    expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
    expectNoReadiness();
    expect(sessionManager.getSession("observer-session")).toBeNull();
  });

  test("a read naming an unissued (observer) session runs on a free device without a session", async () => {
    await call("readProbe", { sessionUuid: "observer-session", deviceId: free.deviceId });

    expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
    expect(audited).toEqual([{ name: "readProbe", deviceId: free.deviceId }]);
    expect(sessionManager.getSession("observer-session")).toBeNull();
    expect(sessionManager.getSessionForDevice(free.deviceId)).toBeNull();
  });

  test("an observer-session read of a tool with its own device read uses it on a free device", async () => {
    const resolved: string[] = [];
    ToolRegistry.registerDeviceAware(
      "observeProbe",
      "Observe-like probe",
      z.object({}).passthrough(),
      async (device: BootedDevice, args: Record<string, unknown>) => {
        reads.push({
          deviceId: device.deviceId,
          readPath: isSessionlessDeviceRead(),
          sessionUuid: args.sessionUuid,
        });
        return { success: true };
      },
      {
        deviceReadOnly: true,
        sessionlessDeviceRead: {
          resolve: async (deviceId: string) => {
            resolved.push(deviceId);
            return free;
          },
          assertAuthorized: () => {},
        },
      },
    );

    await call("observeProbe", { sessionUuid: "observer-session", deviceId: free.deviceId });

    expect(resolved).toEqual([free.deviceId]);
    expect(reads).toEqual([{ deviceId: free.deviceId, readPath: true, sessionUuid: undefined }]);
    expectNoReadiness();
  });

  test("a control call naming an unissued session is still refused as unissued", async () => {
    ToolRegistry.registerDeviceAware(
      "controlProbe",
      "Control probe",
      z.object({}).passthrough(),
      async () => ({ success: true }),
    );
    const error = await outcome("controlProbe", {
      sessionUuid: "observer-session",
      deviceId: free.deviceId,
    });

    expect((error as Error).message).toContain("observer-session");
    expect(audited).toEqual([]);
  });

  describe("registered read tools", () => {
    let disposePrototypeTools: () => void;

    beforeEach(() => {
      serverConfig.setEmbeddedSdkEnabled(true);
      // identifyInteractions is debug-only.
      setDebugModeEnabled(true);
      registerAccessibilityTools();
      registerDeepLinkTools();
      registerInteractionTools();
      registerNavigationTools();
      registerNotificationTools();
      registerObserveTools();
      disposePrototypeTools = registerPrototypeTools();
      registerAppTools();
      registerDatabaseTools();
      registerNetworkTools();
      registerPreferenceTools();
      registerSnapshotOfTools();
      registerStorageTools();
      registerUtilityTools();
    });

    const readCalls: Array<[string, Record<string, unknown>]> = [
      ["getNetworkGraph", {}],
      ["listApps", {}],
      ["snapshotOf", { rectangle: { left: 0, top: 0, right: 10, bottom: 10 } }],
      ["getDeviceState", {}],
      ["listDataStores", { appId: "com.example" }],
      ["getDataStore", { appId: "com.example", name: "settings" }],
      ["getPreference", { appId: "com.example", key: "k" }],
      ["sqlQuery", { appId: "com.example", databasePath: "app.db", query: "SELECT * FROM t" }],
      // #10965: the owner-listed reads, and the read forms of mixed tools.
      ["getAppPermissions", { appId: "com.example" }],
      ["getNotificationPolicy", { appId: "com.example" }],
      ["getDeepLinks", { appId: "com.example" }],
      ["getNavigationGraph", {}],
      ["hitTest", { x: 10, y: 10 }],
      ["identifyInteractions", {}],
      ["keyboard", { action: "detect" }],
      ["keyboard", { action: "listImes" }],
      ["keyboard", { action: "listProfiles" }],
      ["clipboard", { action: "get" }],
      ["displayConfig", {}],
      ["accessibility", {}],
      ["prototype", { action: "status" }],
      ["prototype", { action: "inspect" }],
    ];

    // The control forms of the same tools, and tools that change visible UI (#10965).
    const controlCalls: Array<[string, Record<string, unknown>]> = [
      ["keyboard", { action: "open" }],
      ["keyboard", { action: "setIme", imeId: "com.example/.Ime" }],
      ["clipboard", { action: "copy", text: "x" }],
      ["clipboard", { action: "clear" }],
      ["displayConfig", { theme: "dark" }],
      ["displayConfig", { reset: true }],
      ["accessibility", { talkback: true }],
      ["prototype", { action: "dismiss", all: true }],
      ["systemTray", { action: "list" }],
      ["systemTray", { action: "find", text: "x" }],
    ];

    afterEach(() => {
      disposePrototypeTools();
      setDebugModeEnabled(false);
    });

    // Authorization is denied so each tool stops at the read-only path's own check, before its real
    // handler would reach a device: that error (not the ownership refusal) shows the path taken.
    for (const [name, args] of readCalls) {
      test(`a sessionless ${name} ${JSON.stringify(args)} on a held device takes the read-only path without readiness`, async () => {
        authorized = false;
        const error = await outcome(name, {
          ...args,
          platform: "android",
          deviceId: held.deviceId,
        });

        expect(error).not.toBeInstanceOf(InputDeviceOwnedError);
        expect((error as Error).message).toBe("Observation access denied.");
        expect(listed).toBe(1);
        expectNoReadiness();
      });
    }

    for (const [name, args] of readCalls) {
      test(`a sessionless ${name} ${JSON.stringify(args)} on a free device runs without a session`, async () => {
        const error = await outcome(name, {
          ...args,
          platform: "android",
          deviceId: free.deviceId,
        });

        expect(error).not.toBeInstanceOf(InputDeviceOwnedError);
        expect(audited).toEqual([{ name, deviceId: free.deviceId }]);
        expect(listed).toBe(0);
      });
    }

    for (const [name, args] of controlCalls) {
      test(`a sessionless ${name} ${JSON.stringify(args)} on a held device is refused with the ownership code`, async () => {
        const error = await outcome(name, {
          ...args,
          platform: "android",
          deviceId: held.deviceId,
        });

        expect(error).toBeInstanceOf(InputDeviceOwnedError);
        expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(listed).toBe(0);
        expectNoReadiness();
      });
    }

    test("a sessionless listApps on a held device returns the device's apps", async () => {
      const queried: string[] = [];
      setListAppsToolDependencies({
        queryInstalledApps: async (options) => {
          queried.push(options.deviceId!);
          return {
            totalCount: 0,
            installedCount: 0,
            apps: [],
          } as unknown as AppsQueryResourceContent;
        },
      });
      const response = await call("listApps", { platform: "android", deviceId: held.deviceId });

      expect(queried).toEqual([held.deviceId]);
      expect(JSON.stringify(response)).toContain(`Found 0 app(s) on ${held.deviceId}`);
      expectNoReadiness();
    });

    for (const query of [
      "DELETE FROM t",
      "SELECT 1; DROP TABLE t",
      "PRAGMA journal_mode = DELETE",
      // #10966: a `)` in a literal or comment no longer ends the CTE early.
      "WITH a AS (SELECT ')' UNION SELECT 1) DELETE FROM t",
      "WITH a AS (SELECT 1 /* ) */ UNION SELECT 2) DELETE FROM t",
      'WITH a AS (SELECT ")" UNION SELECT 1) UPDATE t SET b = 1',
    ]) {
      test(`a sessionless sqlQuery write on a held device is refused with the ownership code: ${query}`, async () => {
        const error = await outcome("sqlQuery", {
          appId: "com.example",
          databasePath: "app.db",
          query,
          platform: "android",
          deviceId: held.deviceId,
        });

        expect(error).toBeInstanceOf(InputDeviceOwnedError);
        expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(listed).toBe(0);
        expectNoReadiness();
      });
    }

    test("the holder's sqlQuery write still runs on its device", async () => {
      await call("sqlQuery", {
        appId: "com.example",
        databasePath: "app.db",
        query: "DELETE FROM t",
        sessionUuid: agent,
        deviceId: held.deviceId,
      });

      expect(audited).toEqual([{ name: "sqlQuery", deviceId: held.deviceId }]);
      expect(listed).toBe(0);
    });
  });
});
