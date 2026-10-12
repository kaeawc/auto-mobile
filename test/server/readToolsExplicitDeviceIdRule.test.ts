import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
} from "../../src/daemon/constants";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { matchRunningReadTarget } from "../../src/devices/runningReadTarget";
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceAssignedToManagedSlotError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import type { IosBootInstrumentation } from "../../src/features/iosSimFleet/IosBootInstrumentation";
import {
  isSessionlessDeviceRead,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import {
  ActionableError,
  type BootedDevice,
  type DeviceInfo,
  type Platform,
} from "../../src/models";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { settleByFakeEvents, drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { registerMcpTools } from "../../src/server";
import { sessionlessDeviceReadFor } from "../../src/server/deviceObservationAccess";
import type { BootedResourceReadListing } from "../../src/server/resourceDeviceResolver";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { FakeWindow } from "../fakes/FakeWindow";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

const readArgs: Record<string, Record<string, unknown>> = {
  keyboard: { action: "detect" },
  clipboard: { action: "get" },
  sqlQuery: { query: "SELECT 1" },
  prototype: { action: "inspect" },
};
// All handler bodies are stubbed, so even platform-specific reads can exercise resolution.
const EXPECTED = [
  "accessibility",
  "clipboard",
  "displayConfig",
  "getAppPermissions",
  "getDataStore",
  "getDeepLinks",
  "getDeviceState",
  "getNavigationGraph",
  "getNetworkGraph",
  "getNotificationPolicy",
  "getPreference",
  "hitTest",
  "identifyInteractions",
  "inspectPackageSigning",
  "keyboard",
  "listApps",
  "listDataStores",
  "observe",
  "prototype",
  "snapshotOf",
  "sqlQuery",
];
const deviceFor = (platform: Platform): BootedDevice => ({
  platform,
  name: platform === "android" ? "Named_Pixel" : "Named iPhone",
  deviceId: platform === "android" ? "emulator-5556" : "named-ios",
});

class ReadSimctl extends FakeSimctl {
  async presentSimulatorAfterStart(): Promise<void> {}
}

function harness(platform: Platform, running: boolean, capacity = false, incomplete = false) {
  const device = deviceFor(platform);
  const image: DeviceInfo = { ...device, isRunning: running, isAvailable: true };
  const adb = new FakeAdbExecutor();
  const discovery = new FakeDeviceUtils();
  const simctl = new ReadSimctl();
  const timer = new FakeTimer();
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  const apply = mock(async () => {});
  const getConfig = mock(async () => ({
    syncWithHost: true,
    defaultMode: "auto" as const,
    applyOnConnect: true,
  }));
  const capacityError = new BootCapacityExhaustedError(
    { platform, limit: 1, booted: 1, retryAfterMs: 100 },
    "capacity refused",
  );
  const instrumentation: IosBootInstrumentation = {
    async run(request, boot) {
      if (capacity) {
        throw capacityError;
      }
      return await boot(request.timeoutMs);
    },
  };
  const iosManager = new FakeIOSCtrlProxyManager(timer);
  const iosClient = new FakeIOSCtrlProxy();
  const androidManager = new FakeCtrlProxyManager();
  const androidClient = new FakeCtrlProxy();
  androidClient.setConnected(true);
  iosClient.setConnected(true);
  iosManager.setInstalled(true);
  iosManager.setRunning(true);
  iosManager.setAvailable(true);
  const manager = DeviceSessionManager.createInstance(
    new FakeDeviceClientProvider(adb, discovery, simctl as unknown as SimCtlClient, {
      window,
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
      ctrlProxyManager: androidManager,
      ctrlProxyClient: androidClient,
    }),
    { create: () => adb },
    {
      runnerReadinessTimer: timer,
      idGenerator: new FakeIdGenerator(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
      iosBootInstrumentation: instrumentation,
      appearanceOnConnectDependencies: {
        isSyncEnabled: () => true,
        getConfig,
        resolveMode: async () => "dark",
        apply,
      },
    },
  );
  const devices = running ? [device] : [];
  const scan = {
    devices,
    scanned: {
      android: !incomplete || platform !== "android",
      ios: !incomplete || platform !== "ios",
    },
  };
  const originalDetect = manager.detectConnectedPlatformsWithStatus;
  const originalEnsure = manager.ensureDeviceReady;
  const originalVerify = manager.verifyDevice;
  const detect = spyOn(manager, "detectConnectedPlatformsWithStatus").mockImplementation(
    async () => scan,
  );
  adb.setDevices(platform === "android" ? devices : []);
  discovery.setBootedDevices("android", platform === "android" ? devices : []);
  simctl.setBootedSimulators(platform === "ios" ? devices : []);
  discovery.setDeviceImages("android", platform === "android" ? [image] : []);
  discovery.setMockChildProcess(image.name, null);
  simctl.setAvailableSimulators(platform === "ios" ? [image] : []);
  simctl.setDeviceInfo(device.deviceId, {
    udid: device.deviceId,
    name: device.name,
    state: "Booted",
    isAvailable: true,
  });
  const start = discovery.startDevice.bind(discovery);
  const boots: string[] = [];
  discovery.startDevice = async (target, timeout) => {
    if (capacity) {
      throw capacityError;
    }
    boots.push(target.name);
    const result = await start(target, timeout);
    adb.setDevices(await discovery.getBootedDevices("android"));
    return result;
  };
  const ensure = spyOn(manager, "ensureDeviceReady");
  const verify = spyOn(manager, "verifyDevice");
  return {
    restoreSpies: () => {
      detect.mockRestore();
      ensure.mockRestore();
      verify.mockRestore();
      expect(manager.detectConnectedPlatformsWithStatus).toBe(originalDetect);
      expect(manager.ensureDeviceReady).toBe(originalEnsure);
      expect(manager.verifyDevice).toBe(originalVerify);
    },
    manager,
    discovery,
    device,
    devices,
    adb,
    simctl,
    apply,
    getConfig,
    boots,
    ensure,
    verify,
    detect,
    capacityError,
    iosManager,
    androidManager,
    runs: [] as Array<{ deviceId: string; sessionUuid: unknown; readPath: boolean }>,
  };
}

type Harness = ReturnType<typeof harness>;
let h: Harness | undefined;
let tools: string[] = [];
let restoreFixture: () => void;
let restorePipeline: () => void;
let originals: Map<string, unknown>;
let embeddedBefore: boolean;
let debugBefore: boolean;
let registeredBefore: ReturnType<typeof ToolRegistry.getEveryRegisteredTool>;
const owners = new Map<Platform, { pool: DevicePool; sessions: SessionManager }>();
const unheld = new Map<Platform, { pool: DevicePool; sessions: SessionManager }>();
let slotOwner: { pool: DevicePool; sessions: SessionManager };
let restoreReadTimer: (() => void) | undefined;
let restoreGate: (() => void) | undefined;
const decisions = new Map<string, Map<string, string>>();
const retryTimer = new FakeTimer();
let statusListing: (() => Promise<BootedResourceReadListing>) | undefined;
const access = {
  listBooted: async () => h!.devices,
  listBootedWithStatus: async () =>
    statusListing
      ? statusListing()
      : { devices: h!.devices, scanned: { android: true, ios: true } },
  isAuthorized: () => true,
};

beforeAll(async () => {
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
  registeredBefore = ToolRegistry.getEveryRegisteredTool();
  restoreFixture = installHermeticServerFixture();
  debugBefore = isDebugModeEnabled();
  setDebugModeEnabled(true);
  embeddedBefore = serverConfig.isEmbeddedSdkEnabled();
  serverConfig.setEmbeddedSdkEnabled(true);
  originals = new Map(
    ["deviceSessionManager", "toolCallRepository", "navigationToolCallRecorder"].map((field) => [
      field,
      Reflect.get(ToolRegistry, field),
    ]),
  );
  Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall() {} });
  Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });
  restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
    deviceReadAccess: access,
    displayInventory: new FakeDisplayInventoryProvider(),
    auditRunner: { run: async (input) => input.handler(input.device, input.args) },
    afterToolCall: {
      handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
    },
  });
  // Preserve production options and their classification closures; replace only device I/O.
  const register = ToolRegistry.registerDeviceAware.bind(ToolRegistry);
  const stub = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation(
    (name, description, schema, _handler, options) => {
      register(
        name,
        description,
        schema,
        async (device, args) => {
          h!.runs.push({
            deviceId: device.deviceId,
            sessionUuid: args.sessionUuid,
            readPath: isSessionlessDeviceRead(),
          });
          return { success: true };
        },
        {
          ...options,
          ...(options?.sessionlessDeviceRead
            ? { sessionlessDeviceRead: sessionlessDeviceReadFor(access, { timer: retryTimer }) }
            : {}),
        },
      );
    },
  );
  try {
    ToolRegistry.clearTools();
    registerMcpTools(true);
  } finally {
    stub.mockRestore();
  }
  tools = ToolRegistry.getEveryRegisteredTool()
    .filter(
      (tool) =>
        tool.requiresDevice &&
        tool.isDeviceReadOnlyCall?.({
          platform: "android",
          deviceId: "target",
          ...readArgs[tool.name],
        }),
    )
    .map((tool) => tool.name)
    .sort();
  for (const platform of ["android", "ios"] as const) {
    for (const held of [false, true]) {
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      sessions.stopCleanupTimer();
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, `read-rule-${platform}`, {
          timer,
          deviceManager: new FakeDeviceUtils(),
        }),
      );
      await pool.initializeWithDevices([deviceFor(platform)]);
      if (held) {
        await sessions.createSession(`holder-${platform}`, deviceFor(platform).deviceId, platform);
      }
      (held ? owners : unheld).set(platform, { pool, sessions });
    }
  }
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "read-rule-slot", {
      timer,
      deviceManager: new FakeDeviceUtils(),
    }),
  );
  await pool.initializeWithDevices([]);
  slotOwner = { pool, sessions };
});
afterEach(() => {
  statusListing = undefined;
  retryTimer.reset();
  restoreGate?.();
  restoreGate = undefined;
  restoreReadTimer?.();
  restoreReadTimer = undefined;
  h?.restoreSpies();
  h = undefined;
  Reflect.set(ToolRegistry, "deviceSessionManager", originals.get("deviceSessionManager"));
  expect(Reflect.get(ToolRegistry, "deviceSessionManager")).toBe(
    originals.get("deviceSessionManager"),
  );
  DaemonState.getInstance().reset();
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
  expect(executionTracker.getActiveExecutionCount()).toBe(0);
});
afterAll(() => {
  restorePipeline();
  for (const [field, value] of originals) {
    Reflect.set(ToolRegistry, field, value);
    expect(Reflect.get(ToolRegistry, field)).toBe(value);
  }
  for (const { sessions } of [...owners.values(), ...unheld.values()]) {
    sessions.stopCleanupTimer();
  }
  slotOwner.sessions.stopCleanupTimer();
  serverConfig.setEmbeddedSdkEnabled(embeddedBefore);
  restoreFixture();
  expect(ToolRegistry.getEveryRegisteredTool()).toEqual(registeredBefore);
  setDebugModeEnabled(debugBefore);
  expect(isDebugModeEnabled()).toBe(debugBefore);
  expect(serverConfig.isEmbeddedSdkEnabled()).toBe(embeddedBefore);
});

test("production read-tool enumeration is pinned (including the three issue tools)", () => {
  expect(tools).toEqual(EXPECTED);
  for (const name of ["observe", "listApps", "getDeviceState"]) {
    expect(tools).toContain(name);
  }
});

type Column =
  | "reserved-stopped"
  | "reserved-running"
  | "unnamed"
  | "stopped"
  | "running-id"
  | "running-name"
  | "held-id"
  | "held-name"
  | "held-slot-name"
  | "unknown"
  | "stopped-serial"
  | "stopped-name"
  | "capacity"
  | "incomplete"
  | "ambiguous";
const columns: Column[] = [
  "reserved-stopped",
  "reserved-running",
  "unnamed",
  "stopped",
  "running-id",
  "running-name",
  "held-id",
  "held-name",
  "held-slot-name",
  "unknown",
  "stopped-serial",
  "stopped-name",
  "capacity",
  "incomplete",
  "ambiguous",
];
for (const platform of ["android", "ios"] as const) {
  for (const column of columns) {
    if (
      (column === "stopped-serial" && platform !== "android") ||
      (column === "stopped-name" && platform !== "ios") ||
      // Managed Android slots identify their AVD by name; iOS has no AVD-name holder form.
      (column === "held-slot-name" && platform !== "android")
    ) {
      continue;
    }
    for (const name of EXPECTED) {
      test(`${platform} ${column}: ${name}`, async () => {
        h = harness(
          platform,
          column.startsWith("running") ||
            column.startsWith("held") ||
            column === "reserved-running" ||
            column === "ambiguous",
          column === "capacity",
          column === "incomplete",
        );
        Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
        const held = column.startsWith("held");
        const owner = owners.get(platform)!;
        const holderBefore = structuredClone(owner.sessions.getSession(`holder-${platform}`));
        const daemon =
          column === "held-slot-name" ? slotOwner : held ? owner : unheld.get(platform)!;
        DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
        if (column.startsWith("reserved")) {
          const original = daemon.pool.restartReservationForStart;
          const reservation = spyOn(daemon.pool, "restartReservationForStart").mockImplementation(
            (requestedPlatform, identities, requester) => {
              expect(requester).toEqual({});
              return requestedPlatform === platform &&
                identities.some((id) => [h!.device.name, h!.device.deviceId].includes(id))
                ? {
                    deviceId: h!.device.deviceId,
                    sessionUuid: "restart-owner",
                    owned: true,
                    restartHandoff: true,
                    retryAfterMs: 500,
                  }
                : undefined;
            },
          );
          restoreGate = () => {
            reservation.mockRestore();
            expect(daemon.pool.restartReservationForStart).toBe(original);
          };
        }
        if (column === "held-slot-name") {
          expect(daemon.pool.getDevice(h.device.deviceId)).toBeNull();
          const original = daemon.pool.assertNotAssignedToManagedSlot;
          const gate = spyOn(daemon.pool, "assertNotAssignedToManagedSlot").mockImplementation(
            async (input) => {
              if (input.deviceId === h!.device.name) {
                throw new DeviceAssignedToManagedSlotError(input.action, input.deviceId, {
                  platform: "android",
                  stableDeviceId: h!.device.name,
                  holder: "slot",
                  scopeKey: "scope",
                  slotIndex: 0,
                  scopeState: null,
                  execSessionUuid: "slot-exec",
                });
              }
            },
          );
          restoreGate = () => {
            gate.mockRestore();
            expect(daemon.pool.assertNotAssignedToManagedSlot).toBe(original);
          };
        }
        if (column === "ambiguous") {
          h.devices.push({ ...h.device, deviceId: "second-id" });
        }
        const id =
          column === "unnamed"
            ? undefined
            : column === "unknown"
              ? "missing"
              : column === "stopped-serial"
                ? "emulator-5599"
                : column === "stopped-name" || column.endsWith("name") || column === "ambiguous"
                  ? h.device.name
                  : column === "stopped" ||
                      column === "reserved-stopped" ||
                      column === "capacity" ||
                      column === "incomplete"
                    ? platform === "android"
                      ? h.device.name
                      : h.device.deviceId
                    : h.device.deviceId;
        const args = { platform, ...(id ? { deviceId: id } : {}), ...readArgs[name] };
        const execution = executionTracker.startExecution(name);
        let decision: string;
        try {
          await runWithToolSelectionContext(
            { explicitObserveDeviceRead: name === "observe" && !!id },
            () =>
              ToolRegistry.getTool(name)!.handler({
                ...args,
                [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
                [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
              }),
          );
          decision = `device:${h.runs[0]?.deviceId};boots:${h.boots.length + h.simctl.getMethodCalls("bootSimulator").length}`;
        } catch (error) {
          expect(error).toBeInstanceOf(ActionableError);
          const code: unknown = Reflect.get(error as Error, "code");
          decision = typeof code === "string" ? code : (error as Error).message;
          if (column === "capacity") {
            expect(error).toBe(h.capacityError);
          }
        } finally {
          executionTracker.endExecution(execution.id);
        }
        const key = `${platform}:${column}`;
        const row = decisions.get(key) ?? new Map<string, string>();
        row.set(name, decision);
        decisions.set(key, row);
        const label = platform === "android" ? "Android" : "iOS";
        const expected =
          column === "reserved-stopped"
            ? "device_owned_by_other_session"
            : column === "unnamed"
              ? `No ${label} device is running, so there is nothing to read. Start one with startDevice or provisionDevice, or pass a deviceId.`
              : column === "capacity"
                ? "capacity_exhausted"
                : column === "incomplete"
                  ? "discovery_incomplete"
                  : column === "ambiguous"
                    ? `Ambiguous running device name '${id}'. Candidates: ${[h.device.deviceId, "second-id"].sort().join(", ")}. Provide a deviceId.`
                    : ["unknown", "stopped-serial", "stopped-name"].includes(column)
                      ? `Device ${id} not found on ${platform} platform. Available ${platform} devices: none`
                      : `device:${h.device.deviceId};boots:${column === "stopped" ? 1 : 0}`;
        expect(decision).toBe(expected);
        expect(h.manager.getCurrentDevice()).toBeUndefined();
        expect(h.manager.getCurrentPlatform()).toBeUndefined();
        expect(h.manager.getExplicitDevicePin()).toBeUndefined();
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.getConfig).not.toHaveBeenCalled();
        expect(
          h.adb
            .getExecutedCommands()
            .filter((command) => /settings (put|delete)|cmd uimode/.test(command)),
        ).toEqual([]);
        if (h.runs.length) {
          expect(h.runs[0].sessionUuid).toBeUndefined();
        }
        if (column !== "stopped") {
          expect(h.boots.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(0);
        }
        if (column.startsWith("reserved")) {
          expect(h.ensure).not.toHaveBeenCalled();
          expect(h.verify).not.toHaveBeenCalled();
          expect(h.adb.getExecutedCommands()).toEqual([]);
          expect(h.androidManager.getExecutedOperations()).toEqual([]);
          expect(h.iosManager.getExecutedOperations()).toEqual([]);
          if (column === "reserved-running") {
            expect(h.runs[0].readPath).toBe(true);
          }
        }
        if (held) {
          expect(h.ensure).not.toHaveBeenCalled();
          expect(h.verify).not.toHaveBeenCalled();
          expect(h.adb.getExecutedCommands()).toEqual([]);
          expect(h.androidManager.getExecutedOperations()).toEqual([]);
          expect(h.iosManager.getExecutedOperations()).toEqual([]);
          expect(h.runs[0].readPath).toBe(true);
          if (column === "held-id" || column === "held-slot-name") {
            expect(h.detect).not.toHaveBeenCalled();
          }
          if (column === "held-slot-name") {
            expect(daemon.sessions.getAllSessions()).toEqual([]);
            expect(daemon.sessions.getSessionForDevice(h.device.deviceId)).toBeNull();
          } else {
            expect(owner.sessions.getSession(`holder-${platform}`)).toEqual(holderBefore);
            expect(owner.sessions.getSessionForDevice(h.device.deviceId)).toBe(
              `holder-${platform}`,
            );
          }
        } else {
          expect(daemon.sessions.getAllSessions()).toEqual([]);
          expect(daemon.sessions.getSessionForDevice(h.device.deviceId)).toBeNull();
        }
        if (name === "observe" && column.startsWith("running")) {
          expect(h.ensure).not.toHaveBeenCalled();
        }
        if (name !== "observe" && column.startsWith("running")) {
          expect(h.detect).toHaveBeenCalledTimes(1);
        }
      });
    }
    test(`${platform} ${column}: every tool reaches an identical decision`, () => {
      const row = decisions.get(`${platform}:${column}`) ?? new Map<string, string>();
      // Filtered runs may execute only part of the table (or just this equality pin).
      expect(new Set(row.values()).size).toBe(row.size ? 1 : 0);
      if (row.size === EXPECTED.length) {
        expect([...row.keys()].sort()).toEqual(EXPECTED);
        expect(row.get("observe")).toBe(row.get("listApps"));
        expect(row.get("observe")).toBe(row.get("getDeviceState"));
      }
    });
  }
}

test("a serial acquired during discovery is rechecked before readiness", async () => {
  h = harness("android", true);
  Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
  DaemonState.getInstance().initialize(slotOwner.sessions, slotOwner.pool);
  let acquired = false;
  h.detect.mockImplementation(async () => {
    acquired = true;
    return { devices: h!.devices, scanned: { android: true, ios: true } };
  });
  const original = slotOwner.sessions.getSessionForDevice;
  const holder = spyOn(slotOwner.sessions, "getSessionForDevice").mockImplementation((deviceId) =>
    acquired && deviceId === h!.device.deviceId ? "late-holder" : null,
  );
  try {
    await ToolRegistry.getTool("listApps")!.handler({
      platform: "android",
      deviceId: h.device.deviceId,
    });
    expect(h.runs).toEqual([
      { deviceId: h.device.deviceId, sessionUuid: undefined, readPath: true },
    ]);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.adb.getExecutedCommands()).toEqual([]);
  } finally {
    holder.mockRestore();
    expect(slotOwner.sessions.getSessionForDevice).toBe(original);
  }
});

test("control naming a stopped AVD keeps the provided-device not-found outcome", async () => {
  h = harness("android", false);
  Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
  const daemon = unheld.get("android")!;
  DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
  // Control bypasses resolveReadinessReadTarget's read boot; requireProvidedReadinessDevice rejects.
  await expect(
    ToolRegistry.getTool("tapOn")!.handler({ platform: "android", deviceId: h.device.name }),
  ).rejects.toThrow(
    `Device ${h.device.name} not found on android platform. Available android devices: none`,
  );
  expect(h.ensure).toHaveBeenCalledTimes(1);
  expect(h.ensure.mock.calls[0][2]?.intent).toBeUndefined();
  expect(h.boots).toEqual([]);
  expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
  expect(h.verify).not.toHaveBeenCalled();
  expect(h.runs).toEqual([]);
  expect(h.adb.getExecutedCommands()).toEqual([]);
});

for (const name of ["observe", "listApps", "getDeviceState"]) {
  test(`session-bound foreign running read: ${name}`, async () => {
    h = harness("android", true);
    const foreign = { ...h.device, deviceId: "emulator-5590", name: "Foreign" };
    h.devices.splice(0, h.devices.length, foreign);
    Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
    const owner = owners.get("android")!;
    DaemonState.getInstance().initialize(owner.sessions, owner.pool);
    const before = structuredClone(owner.sessions.getSession("holder-android"));
    await ToolRegistry.getTool(name)!.handler({
      platform: "android",
      deviceId: foreign.deviceId,
      sessionUuid: "holder-android",
    });
    expect(h.runs).toEqual([
      { deviceId: foreign.deviceId, sessionUuid: undefined, readPath: true },
    ]);
    expect(owner.sessions.getSession("holder-android")).toEqual(before);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.boots).toEqual([]);
    expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
  });
}

test("shared running matcher: exact id wins, one/none/ambiguous, and platform filter", () => {
  const android = deviceFor("android");
  const ios = { ...deviceFor("ios"), name: android.name };
  expect(matchRunningReadTarget([android, ios], android.deviceId)).toBe(android);
  expect(matchRunningReadTarget([android], android.name)).toBe(android);
  expect(matchRunningReadTarget([android, ios], android.name, "ios")).toBe(ios);
  expect(matchRunningReadTarget([android], android.deviceId, "ios")).toBeUndefined();
  expect(matchRunningReadTarget([android], "unknown")).toBeUndefined();
  expect(() => matchRunningReadTarget([ios, android], android.name)).toThrow(
    "Ambiguous running device name 'Named_Pixel'. Candidates: emulator-5556, named-ios. Provide a deviceId.",
  );
  expect(
    matchRunningReadTarget([android, { ...ios, name: android.deviceId }], android.deviceId),
  ).toBe(android);
});

for (const platform of ["android", "ios"] as const) {
  for (const phase of ["scan", "images"] as const) {
    for (const kind of ["holder", "reservation"] as const) {
      test(`${platform}: ${kind} appears during ${phase}, no read boot`, async () => {
        h = harness(platform, false);
        Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
        DaemonState.getInstance().initialize(slotOwner.sessions, slotOwner.pool);
        const id = platform === "android" ? h.device.name : h.device.deviceId;
        let claimed = false;
        if (phase === "scan") {
          h.detect.mockImplementation(async () => {
            claimed = true;
            return { devices: [], scanned: { android: true, ios: true } };
          });
        } else if (platform === "android") {
          const list = h.discovery.listDeviceImages.bind(h.discovery);
          h.discovery.listDeviceImages = async (...args) => {
            claimed = true;
            return list(...args);
          };
        } else {
          const list = h.simctl.listSimulatorImages.bind(h.simctl);
          h.simctl.listSimulatorImages = async (...args) => {
            claimed = true;
            return list(...args);
          };
        }
        const originalHolder = slotOwner.sessions.getSessionForDevice;
        const originalReservation = slotOwner.pool.restartReservationForStart;
        const holder = spyOn(slotOwner.sessions, "getSessionForDevice").mockImplementation(
          (target) => (claimed && kind === "holder" && target === id ? "late-owner" : null),
        );
        const reservation = spyOn(slotOwner.pool, "restartReservationForStart").mockImplementation(
          (p, identities, requester) => {
            expect(requester).toEqual({});
            return claimed && kind === "reservation" && p === platform && identities.includes(id)
              ? {
                  deviceId: h!.device.deviceId,
                  sessionUuid: "late-owner",
                  owned: false,
                  restartHandoff: true,
                  retryAfterMs: 500,
                }
              : undefined;
          },
        );
        const execution = executionTracker.startExecution("listApps");
        try {
          const result = await ToolRegistry.getTool("listApps")!
            .handler({
              platform,
              deviceId: id,
              [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
              [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
            })
            .catch((error: unknown) => error);
          if (kind === "reservation") {
            expect(result).toMatchObject({ code: "device_owned_by_other_session" });
          } else {
            expect(result).toMatchObject({
              message: `Device ${id} not found on ${platform} platform. Available ${platform} devices: none`,
            });
          }
          expect(h.boots).toEqual([]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
          expect(h.verify).not.toHaveBeenCalled();
          expect(h.runs).toEqual([]);
          expect(execution.sessionlessDeviceUse?.size ?? 0).toBe(0);
        } finally {
          executionTracker.endExecution(execution.id);
          holder.mockRestore();
          reservation.mockRestore();
          expect(slotOwner.sessions.getSessionForDevice).toBe(originalHolder);
          expect(slotOwner.pool.restartReservationForStart).toBe(originalReservation);
        }
      });
    }
  }
}

for (const platform of ["android", "ios"] as const) {
  for (const scenario of ["recovers", "fails", "aborts", "healthy-other", "held-fails"] as const) {
    test(`${platform} explicit observe discovery: ${scenario}`, async () => {
      h = harness(platform, true);
      Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
      const daemon = (scenario === "held-fails" ? owners : unheld).get(platform)!;
      DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
      let listings = 0;
      statusListing = async () => {
        listings++;
        const healthy = scenario === "healthy-other" || (scenario === "recovers" && listings === 2);
        return {
          devices: healthy ? h!.devices : [],
          scanned: {
            android: platform === "android" ? healthy : scenario !== "healthy-other",
            ios: platform === "ios" ? healthy : scenario !== "healthy-other",
          },
        };
      };
      const controller = new AbortController();
      const work = runWithToolSelectionContext(
        { explicitObserveDeviceRead: scenario !== "held-fails" },
        () =>
          ToolRegistry.getTool("observe")!.handler(
            { deviceId: h!.device.deviceId, platform },
            undefined,
            controller.signal,
          ),
      );
      const outcome = work.catch((error: unknown) => error);
      if (scenario === "aborts") {
        await drainUntilQuiescent(retryTimer);
        expect(listings).toBe(1);
        expect(retryTimer.getPendingTimeoutCount()).toBe(1);
        controller.abort(new ActionableError("read cancelled"));
        expect(await outcome).toMatchObject({ message: "read cancelled" });
        expect(listings).toBe(1);
        expect(retryTimer.getPendingTimeoutCount()).toBe(0);
      } else {
        const result = await settleByFakeEvents(retryTimer, outcome, { description: scenario });
        if (scenario === "fails" || scenario === "held-fails") {
          expect(result).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
          expect(result).toMatchObject({
            code: "discovery_incomplete",
            platform,
            retryable: true,
          });
          expect((result as Error).message).not.toContain("Available");
          expect(listings).toBe(3);
          expect(retryTimer.now()).toBe(1000);
        } else {
          expect(h.runs[0].readPath).toBe(true);
          expect(listings).toBe(scenario === "recovers" ? 2 : 1);
          expect(retryTimer.now()).toBe(scenario === "recovers" ? 250 : 0);
        }
      }
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.boots).toEqual([]);
      expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
      expect(h.detect).not.toHaveBeenCalled();
    });
  }
}

for (const platform of ["android", "ios"] as const) {
  for (const requested of [undefined, "either"] as const) {
    for (const identity of ["name", "deviceId"] as const) {
      test(`${platform} stopped reserved ${identity}, platform=${requested ?? "absent"}`, async () => {
        h = harness(platform, false);
        Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
        const daemon = unheld.get(platform)!;
        DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
        const id = h.device[identity];
        const original = daemon.pool.restartReservationForStart;
        const queried: string[] = [];
        const reservation = spyOn(daemon.pool, "restartReservationForStart").mockImplementation(
          (p, identities, requester) => {
            queried.push(p);
            expect(requester).toEqual({});
            return p === platform && identities.includes(id)
              ? {
                  deviceId: h!.device.deviceId,
                  sessionUuid: "restart-owner",
                  owned: true,
                  restartHandoff: true,
                  retryAfterMs: 500,
                }
              : undefined;
          },
        );
        try {
          await expect(
            ToolRegistry.getTool("listApps")!.handler({
              deviceId: id,
              ...(requested ? { platform: requested } : {}),
            }),
          ).rejects.toMatchObject({
            code: "device_owned_by_other_session",
            retryable: true,
            retryAfterMs: 500,
          });
          expect(queried).toContain(platform);
          if (platform === "ios") {
            expect(queried).toContain("android");
          }
          expect(h.ensure).not.toHaveBeenCalled();
          expect(h.verify).not.toHaveBeenCalled();
          expect(h.boots).toEqual([]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
        } finally {
          reservation.mockRestore();
          expect(daemon.pool.restartReservationForStart).toBe(original);
        }
      });
    }
  }
}

function useFakeReadRetryTimer(): void {
  if (restoreReadTimer) {
    return;
  }
  const original = {
    now: defaultTimer.now,
    setTimeout: defaultTimer.setTimeout,
    clearTimeout: defaultTimer.clearTimeout,
    sleep: defaultTimer.sleep,
  };
  const sleep = spyOn(defaultTimer, "sleep").mockImplementation((ms) => retryTimer.sleep(ms));
  const now = spyOn(defaultTimer, "now").mockImplementation(() => retryTimer.now());
  const set = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
    retryTimer.setTimeout(callback, ms),
  );
  const clear = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
    retryTimer.clearTimeout(handle),
  );
  restoreReadTimer = () => {
    now.mockRestore();
    set.mockRestore();
    clear.mockRestore();
    sleep.mockRestore();
    expect(defaultTimer.sleep).toBe(original.sleep);
    expect(defaultTimer.now).toBe(original.now);
    expect(defaultTimer.setTimeout).toBe(original.setTimeout);
    expect(defaultTimer.clearTimeout).toBe(original.clearTimeout);
  };
}

function reserveReadTarget(platform: Platform, id: string): void {
  const pool = unheld.get(platform)!.pool;
  const original = pool.restartReservationForStart;
  const reservation = spyOn(pool, "restartReservationForStart").mockImplementation(
    (p, identities, requester) => {
      expect(requester).toEqual({});
      return p === platform && identities.includes(id)
        ? {
            deviceId: h!.device.deviceId,
            sessionUuid: "restart-owner",
            owned: true,
            restartHandoff: true,
            retryAfterMs: 500,
          }
        : undefined;
    },
  );
  restoreGate = () => {
    reservation.mockRestore();
    expect(pool.restartReservationForStart).toBe(original);
  };
}

async function onePlatformDecision(
  platform: Platform,
  name: "observe" | "listApps",
  scenario: "stopped" | "unknown" | "reserved" | "running",
  requested?: "either",
): Promise<{ decision: string; listings: number }> {
  useFakeReadRetryTimer();
  h = harness(platform, scenario === "running");
  Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
  const daemon = unheld.get(platform)!;
  DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
  const other = platform === "android" ? "ios" : "android";
  const scanned = { android: platform === "android", ios: platform === "ios" };
  h.detect.mockImplementation(async () => ({ devices: h!.devices, scanned }));
  let listings = 0;
  statusListing = async () => {
    listings++;
    return {
      devices: h!.devices,
      scanned,
      discoveryErrors: { [other]: { code: "unavailable", message: "tooling absent" } },
    };
  };
  const id =
    scenario === "unknown"
      ? "unknown-id"
      : platform === "android"
        ? h.device.name
        : h.device.deviceId;
  if (scenario === "reserved") {
    reserveReadTarget(platform, id);
  }
  const outcome = runWithToolSelectionContext(
    { explicitObserveDeviceRead: name === "observe" },
    () =>
      ToolRegistry.getTool(name)!.handler({
        deviceId: id,
        ...(requested ? { platform: requested } : {}),
      }),
  ).catch((error: unknown) => error);
  const result = await settleByFakeEvents(retryTimer, outcome, { description: scenario });
  let decision: string;
  if (scenario === "reserved") {
    expect(result).toMatchObject({ code: "device_owned_by_other_session", retryAfterMs: 500 });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.boots).toEqual([]);
    expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
    decision = "device_owned_by_other_session";
  } else if (scenario === "unknown") {
    // The normal readiness path on main cannot prove absence on an incomplete either scan.
    expect(result).toMatchObject({ code: "discovery_incomplete", platform: other });
    decision = "discovery_incomplete";
  } else {
    expect(h.runs).toHaveLength(1);
    decision = `device:${h.runs[0].deviceId};boots:${h.boots.length + h.simctl.getMethodCalls("bootSimulator").length}`;
    expect(decision).toBe(`device:${h.device.deviceId};boots:${scenario === "stopped" ? 1 : 0}`);
  }
  expect(retryTimer.now()).toBe(0);
  expect(retryTimer.getPendingTimeoutCount()).toBe(0);
  expect(retryTimer.getPendingSleepCount()).toBe(0);
  expect(retryTimer.getSleepCallCount()).toBe(0);
  expect(listings).toBe(
    scenario === "reserved" ? (name === "observe" ? 2 : 1) : name === "observe" ? 1 : 0,
  );
  return { decision, listings };
}

for (const platform of ["android", "ios"] as const) {
  for (const requested of [undefined, "either"] as const) {
    for (const scenario of ["stopped", "unknown", "reserved", "running"] as const) {
      test(`${platform} one-platform ${scenario}, platform=${requested ?? "absent"}: observe agrees with listApps`, async () => {
        const normal = await onePlatformDecision(platform, "listApps", scenario, requested);
        // Restore the first harness's spies before replacing it in the same test.
        restoreGate?.();
        restoreGate = undefined;
        h!.restoreSpies();
        const explicit = await onePlatformDecision(platform, "observe", scenario, requested);
        expect(explicit.decision).toBe(normal.decision);
      });
    }
  }
  for (const name of ["observe", "listApps"] as const) {
    test(`${platform} reserved ${name} overrides failed discovery`, async () => {
      useFakeReadRetryTimer();
      h = harness(platform, false);
      Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
      const daemon = unheld.get(platform)!;
      DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
      const id = h.device.deviceId;
      reserveReadTarget(platform, id);
      let listings = 0;
      statusListing = async () => {
        listings++;
        return {
          devices: [],
          scanned: { android: false, ios: false },
          discoveryErrors: { [platform]: { code: "failed", message: "listing blipped" } },
        };
      };
      const result = await settleByFakeEvents(
        retryTimer,
        runWithToolSelectionContext({ explicitObserveDeviceRead: name === "observe" }, () =>
          ToolRegistry.getTool(name)!.handler({ deviceId: id, platform }),
        ).catch((error: unknown) => error),
        { description: "reserved listing failed" },
      );
      expect(result).toMatchObject({ code: "device_owned_by_other_session", retryAfterMs: 500 });
      expect(listings).toBe(3);
      expect(retryTimer.now()).toBe(1000);
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.boots).toEqual([]);
      expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
    });
  }
  test(`${platform} explicitly unavailable platform does not retry`, async () => {
    h = harness(platform, false);
    Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
    let listings = 0;
    statusListing = async () => {
      listings++;
      return {
        devices: [],
        scanned: { android: false, ios: false },
        discoveryErrors: { [platform]: { code: "unavailable", message: "tooling absent" } },
      };
    };
    const result = await settleByFakeEvents(
      retryTimer,
      runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
        ToolRegistry.getTool("observe")!.handler({ deviceId: h!.device.deviceId, platform }),
      ).catch((error: unknown) => error),
      { description: "unavailable platform" },
    );
    expect(result).toMatchObject({ code: "discovery_incomplete", platform });
    expect(listings).toBe(1);
    expect(retryTimer.now()).toBe(0);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  test(`${platform} abort without reason during read backoff preserves signal reason`, async () => {
    h = harness(platform, false);
    Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
    let listings = 0;
    statusListing = async () => {
      listings++;
      return { devices: [], scanned: { android: false, ios: false } };
    };
    const controller = new AbortController();
    const outcome = runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      ToolRegistry.getTool("observe")!.handler(
        { deviceId: h!.device.deviceId, platform },
        undefined,
        controller.signal,
      ),
    ).catch((error: unknown) => error);
    await drainUntilQuiescent(retryTimer);
    expect(listings).toBe(1);
    expect(retryTimer.getPendingTimeoutCount()).toBe(1);
    controller.abort();
    const result = await outcome;
    expect(result).toBe(controller.signal.reason);
    expect(result).toBeInstanceOf(DOMException);
    expect(result).toHaveProperty("name", "AbortError");
    expect(listings).toBe(1);
    expect(retryTimer.getPendingTimeoutCount()).toBe(0);
  });
}
