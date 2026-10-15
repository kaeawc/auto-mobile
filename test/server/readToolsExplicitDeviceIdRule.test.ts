import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
} from "../../src/daemon/constants";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { matchRunningReadTarget } from "../../src/devices/runningReadTarget";
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceAssignedToBindingError } from "../../src/daemon/sessionBroker/provisioning/refusal";
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
import { settleByFakeEvents, drainUntilQuiescent, drainUntil } from "../helpers/fakeTimerStepping";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { registerMcpTools } from "../../src/server";
import {
  resolveDeviceForObservationRead,
  sessionlessDeviceReadFor,
} from "../../src/server/deviceObservationAccess";
import {
  listBootedDevicesForReadWithStatus,
  type BootedResourceReadListing,
} from "../../src/server/resourceDeviceResolver";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { snapshotPlatformDeviceManagerFactory } from "../helpers/platformDeviceManagerSnapshot";
import {
  AndroidEmulatorClient,
  resetAndroidInventoryEnrichmentCache,
} from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { createExecResult } from "../../src/utils/execResult";
import { executionTracker } from "../../src/server/executionTracker";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
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

function harness(
  platform: Platform,
  running: boolean,
  capacity = false,
  incomplete = false,
  shaped = false,
  notReady = false,
) {
  const device = deviceFor(platform);
  if (shaped && platform === "ios") {
    device.deviceId = "12345678-ABCD-ABCD-ABCD-123456789ABC";
  }
  const image: DeviceInfo =
    platform === "android"
      ? { name: device.name, platform, isRunning: running, isAvailable: true, source: "local" }
      : { ...device, isRunning: running, isAvailable: true };
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
  androidClient.setConnected(!notReady);
  iosClient.setConnected(!notReady);
  iosManager.setInstalled(!notReady);
  iosManager.setRunning(!notReady);
  iosManager.setAvailable(!notReady);
  if (notReady) {
    // The cold runner setup succeeds, then the fake connection succeeds without a retry sleep.
    iosClient.setConnectWithoutSetupResult(true);
  }
  const lifecycle = new FakeVirtualDeviceLifecycleCoordinator();
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
      lifecycleCoordinator: lifecycle,
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
  const wait = discovery.waitForDeviceReady.bind(discovery);
  discovery.waitForDeviceReady = (target, ...args) =>
    wait({ ...target, deviceId: device.deviceId }, ...args);
  const start = discovery.startDevice.bind(discovery);
  const boots: string[] = [];
  discovery.startDevice = async (target, timeout) => {
    if (capacity) {
      throw capacityError;
    }
    boots.push(target.name);
    const result = await start(
      platform === "android" ? { ...target, deviceId: device.deviceId } : target,
      timeout,
    );
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
    lifecycle,
    timer,
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
    handledDevices: [] as BootedDevice[],
    handlerSignals: [] as Array<AbortSignal | undefined>,
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
let restoreProbeInventory: (() => Promise<void>) | undefined;
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
          h!.handledDevices.push(device);
          h!.handlerSignals.push(getAbortSignal());
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
afterEach(async () => {
  await restoreProbeInventory?.();
  restoreProbeInventory = undefined;
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

// Characterize registry readiness with real registration options and stubbed tool bodies.
// observe's separate hierarchy-service start is tested by ObservationReadServiceStart tests.
const READS_THAT_READY_UNHELD = {
  android: [
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
    "keyboard",
    "listDataStores",
    "prototype",
    "snapshotOf",
    "sqlQuery",
  ],
  ios: [
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
    "keyboard",
    "listDataStores",
    "prototype",
    "snapshotOf",
    "sqlQuery",
  ],
};
const READS_WITHOUT_UNHELD_READINESS = {
  android: [
    "inspectPackageSigning", // Declares booted readiness; no CtrlProxy setup.
    "listApps", // Declares booted readiness; no CtrlProxy setup.
    "observe", // Explicit deviceId uses the observer path; no ensureDeviceReady.
  ],
  ios: [
    "inspectPackageSigning", // Declares booted readiness; no runner setup.
    "listApps", // Declares booted readiness; no runner setup.
    "observe", // Explicit deviceId uses the observer path; no ensureDeviceReady.
  ],
};
const observedReadiness = new Map<Platform, Map<string, boolean>>();

test("documented unheld registry readiness matches literal classifications", () => {
  const lines = readFileSync(
    join(import.meta.dir, "../../docs/using/device-ownership.md"),
    "utf8",
  ).split(/\r?\n/);
  const start = lines.indexOf("### Which read tools ready an unheld device");
  expect(start).toBeGreaterThanOrEqual(0);
  const section = lines.slice(start + 1);
  const end = section.findIndex((line) => /^#{1,3} /.test(line));
  const rows = (end === -1 ? section : section.slice(0, end)).flatMap((line) => {
    const row = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*$/.exec(line);
    return row ? [{ name: row[1], android: row[2].trim(), ios: row[3].trim() }] : [];
  });
  expect(rows.map(({ name }) => name)).toEqual(EXPECTED);
  for (const platform of ["android", "ios"] as const) {
    for (const row of rows) {
      expect(row[platform].startsWith("Yes"), `${platform} ${row.name}`).toBe(
        READS_THAT_READY_UNHELD[platform].includes(row.name),
      );
    }
  }
});

test("unheld readiness literal lists partition all 21 production reads", () => {
  for (const platform of ["android", "ios"] as const) {
    const classified = [
      ...READS_THAT_READY_UNHELD[platform],
      ...READS_WITHOUT_UNHELD_READINESS[platform],
    ];
    expect(classified.sort()).toEqual(EXPECTED);
    expect(new Set(classified).size).toBe(EXPECTED.length);
    expect(tools).toEqual(EXPECTED);
  }
});

for (const platform of ["android", "ios"] as const) {
  for (const name of EXPECTED) {
    test(`${platform} unheld running not ready: ${name}`, async () => {
      h = harness(platform, true, false, false, false, true);
      Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
      const daemon = unheld.get(platform)!;
      DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
      const execution = executionTracker.startExecution(name);
      try {
        const response = await runWithToolSelectionContext(
          { explicitObserveDeviceRead: name === "observe" },
          () =>
            ToolRegistry.getTool(name)!.handler({
              platform,
              deviceId: h!.device.deviceId,
              ...readArgs[name],
              [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
              [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
            }),
        );
        expect(response).toMatchObject({ success: true });
      } finally {
        executionTracker.endExecution(execution.id);
      }
      expect(h.handledDevices).toEqual([h.device]);
      expect(h.runs).toHaveLength(1);
      expect(h.runs[0].sessionUuid).toBeUndefined();
      const operations = (
        platform === "android" ? h.androidManager : h.iosManager
      ).getExecutedOperations();
      const mutated = operations.some((operation) =>
        platform === "android"
          ? operation.startsWith("setup:") ||
            operation.startsWith("install:") ||
            operation === "enable"
          : operation.startsWith("setup:") || operation === "start",
      );
      const readIntent = h.ensure.mock.calls.some((call) => call[2]?.intent === "read");
      const ran = readIntent && mutated;
      const expected = READS_THAT_READY_UNHELD[platform].includes(name);
      expect(ran).toBe(expected);
      // Pin both halves independently: readiness cannot silently switch to control intent.
      expect(mutated).toBe(expected);
      if (name === "observe") {
        expect(h.ensure).not.toHaveBeenCalled();
      } else {
        expect(readIntent).toBe(true);
      }
      const observed = observedReadiness.get(platform) ?? new Map<string, boolean>();
      observed.set(name, ran);
      observedReadiness.set(platform, observed);
      expect(daemon.sessions.getAllSessions()).toEqual([]);
      expect(h.manager.getCurrentDevice()).toBeUndefined();
      expect(h.manager.getCurrentPlatform()).toBeUndefined();
      expect(h.manager.getExplicitDevicePin()).toBeUndefined();
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.getConfig).not.toHaveBeenCalled();
      expect(
        h.adb.getExecutedCommands().filter((command) => command.includes("cmd uimode")),
      ).toEqual([]);
    });
  }
  test(`${platform} unheld running not ready: observed sets equal literal classifications`, () => {
    const observed = observedReadiness.get(platform) ?? new Map<string, boolean>();
    if (observed.size === EXPECTED.length) {
      expect([...observed.keys()].sort()).toEqual(EXPECTED);
      expect(
        [...observed]
          .filter(([, ran]) => ran)
          .map(([name]) => name)
          .sort(),
      ).toEqual(READS_THAT_READY_UNHELD[platform]);
      expect(
        [...observed]
          .filter(([, ran]) => !ran)
          .map(([name]) => name)
          .sort(),
      ).toEqual(READS_WITHOUT_UNHELD_READINESS[platform]);
    } else {
      for (const [name, ran] of observed) {
        expect(EXPECTED).toContain(name);
        expect(ran).toBe(READS_THAT_READY_UNHELD[platform].includes(name));
      }
    }
  });
}

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
  | "ambiguous"
  | "failed-other-stopped"
  | "failed-other-unknown"
  | "failed-other-shaped-running"
  | "failed-own-shaped-running"
  | "healthy-shaped-running"
  | "failed-other-shaped-absent"
  | "failed-other-running-name"
  | "failed-other-reserved";
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
  "failed-other-stopped",
  "failed-other-unknown",
  "failed-other-shaped-running",
  "failed-own-shaped-running",
  "healthy-shaped-running",
  "failed-other-shaped-absent",
  "failed-other-running-name",
  "failed-other-reserved",
];
const notReadyColumns: Column[] = ["held-id", "held-name", "held-slot-name", "reserved-running"];
for (const platform of ["android", "ios"] as const) {
  for (const { column, notReady } of [
    ...columns.map((column) => ({ column, notReady: false })),
    ...notReadyColumns.map((column) => ({ column, notReady: true })),
  ]) {
    const columnLabel = `${column}${notReady ? " not ready" : ""}`;
    if (
      (column === "stopped-serial" && platform !== "android") ||
      (column === "stopped-name" && platform !== "ios") ||
      // Managed Android slots identify their AVD by name; iOS has no AVD-name holder form.
      (column === "held-slot-name" && platform !== "android")
    ) {
      continue;
    }
    const exactRunningPin =
      column === "failed-own-shaped-running" || column === "healthy-shaped-running";
    for (const requested of (exactRunningPin
      ? [undefined]
      : column.startsWith("failed-other")
        ? [undefined, "either"]
        : [platform]) as readonly (Platform | "either" | undefined)[]) {
      for (const name of EXPECTED.filter((name) => !exactRunningPin || name !== "observe")) {
        test(`${platform} ${columnLabel}, platform=${requested ?? "absent"}: ${name}`, async () => {
          const failedOther = column.startsWith("failed-other");
          if (failedOther || exactRunningPin) {
            useFakeReadRetryTimer();
          }
          let listings = 0;
          h = harness(
            platform,
            column.startsWith("running") ||
              column.startsWith("held") ||
              column === "reserved-running" ||
              column === "ambiguous" ||
              column === "failed-other-running-name" ||
              column === "failed-other-shaped-running" ||
              exactRunningPin,
            column === "capacity",
            column === "incomplete",
            column.startsWith("failed-other-shaped") || exactRunningPin,
            notReady,
          );
          const other = platform === "android" ? "ios" : "android";
          if (failedOther) {
            const scanned = { android: platform === "android", ios: platform === "ios" };
            h.detect.mockImplementation(async () => ({ devices: h!.devices, scanned }));
            statusListing = async () => {
              listings++;
              return {
                devices: h!.devices,
                scanned,
                discoveryErrors: { [other]: { code: "failed", message: "other listing failed" } },
              };
            };
          }
          if (exactRunningPin) {
            const failedOwn = column === "failed-own-shaped-running";
            statusListing = async () => {
              listings++;
              return {
                devices: h!.devices,
                scanned: {
                  android: !failedOwn || platform !== "android",
                  ios: !failedOwn || platform !== "ios",
                },
                ...(failedOwn
                  ? {
                      discoveryErrors: {
                        [platform]: { code: "failed", message: "own listing failed" },
                      },
                    }
                  : {}),
              };
            };
          }
          Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
          const held = column.startsWith("held");
          const owner = owners.get(platform)!;
          const holderBefore = structuredClone(owner.sessions.getSession(`holder-${platform}`));
          const daemon =
            column === "held-slot-name" ? slotOwner : held ? owner : unheld.get(platform)!;
          DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
          if (column.startsWith("reserved") || column === "failed-other-reserved") {
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
            const original = daemon.pool.assertNotAssignedToBinding;
            const gate = spyOn(daemon.pool, "assertNotAssignedToBinding").mockImplementation(
              async (input) => {
                if (input.deviceId === h!.device.name) {
                  throw new DeviceAssignedToBindingError(input.action, input.deviceId, {
                    platform: "android",
                    stableDeviceId: h!.device.name,
                    holder: "session_broker",
                    scopeKey: "scope",
                    bindingIndex: 0,
                    scopeState: null,
                    execSessionUuid: "slot-exec",
                  });
                }
              },
            );
            restoreGate = () => {
              gate.mockRestore();
              expect(daemon.pool.assertNotAssignedToBinding).toBe(original);
            };
          }
          if (column === "ambiguous") {
            h.devices.push({ ...h.device, deviceId: "second-id" });
          }
          const id =
            column === "unnamed"
              ? undefined
              : column === "unknown" || column === "failed-other-unknown"
                ? "missing"
                : column === "failed-other-shaped-absent"
                  ? platform === "android"
                    ? "emulator-5599"
                    : "87654321-ABCD-ABCD-ABCD-123456789ABC"
                  : column === "stopped-serial"
                    ? "emulator-5599"
                    : column === "stopped-name" || column.endsWith("name") || column === "ambiguous"
                      ? h.device.name
                      : column === "stopped" ||
                          column === "reserved-stopped" ||
                          column === "capacity" ||
                          column === "incomplete" ||
                          column === "failed-other-stopped" ||
                          column === "failed-other-reserved"
                        ? platform === "android"
                          ? h.device.name
                          : h.device.deviceId
                        : h.device.deviceId;
          const args = {
            ...(requested ? { platform: requested } : {}),
            ...(id ? { deviceId: id } : {}),
            ...readArgs[name],
          };
          const execution = executionTracker.startExecution(name);
          let decision: string;
          try {
            const outcome = runWithToolSelectionContext(
              { explicitObserveDeviceRead: name === "observe" && !!id },
              () =>
                ToolRegistry.getTool(name)!.handler({
                  ...args,
                  [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
                  [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
                }),
            );
            if (failedOther || exactRunningPin) {
              await settleByFakeEvents(retryTimer, outcome, { description: column });
            } else {
              await outcome;
            }
            decision = `device:${h.runs[0]?.deviceId};boots:${h.boots.length + h.simctl.getMethodCalls("bootSimulator").length}`;
          } catch (error) {
            expect(error).toBeInstanceOf(ActionableError);
            const code: unknown = Reflect.get(error as Error, "code");
            decision = typeof code === "string" ? code : (error as Error).message;
            if (column === "failed-other-unknown") {
              expect(error).toMatchObject({
                code: "discovery_incomplete",
                platform: other,
                retryable: true,
              });
            }
            if (column === "capacity") {
              expect(error).toBe(h.capacityError);
            }
          } finally {
            executionTracker.endExecution(execution.id);
          }
          const key = `${platform}:${columnLabel}:${requested ?? "absent"}`;
          const row = decisions.get(key) ?? new Map<string, string>();
          row.set(name, decision);
          decisions.set(key, row);
          const label = platform === "android" ? "Android" : "iOS";
          const expected =
            column === "reserved-stopped" || column === "failed-other-reserved"
              ? "device_owned_by_other_session"
              : column === "unnamed"
                ? `No ${label} device is running, so there is nothing to read. Start one with startDevice or provisionDevice, or pass a deviceId.`
                : column === "capacity"
                  ? "capacity_exhausted"
                  : column === "incomplete" || column === "failed-other-unknown"
                    ? "discovery_incomplete"
                    : column === "ambiguous"
                      ? `Ambiguous running device name '${id}'. Candidates: ${[h.device.deviceId, "second-id"].sort().join(", ")}. Provide a deviceId.`
                      : [
                            "unknown",
                            "stopped-serial",
                            "stopped-name",
                            "failed-other-shaped-absent",
                          ].includes(column)
                        ? `Device ${id} not found on ${requested ?? "either"} platform. Available ${requested ?? "either"} devices: none`
                        : `device:${h.device.deviceId};boots:${column === "stopped" || column === "failed-other-stopped" ? 1 : 0}`;
          expect(decision).toBe(expected);
          if (failedOther) {
            const retried = column === "failed-other-unknown" || column === "failed-other-reserved";
            expect(retryTimer.now()).toBe(retried ? 1000 : 0);
            expect(retryTimer.getSleepCallCount()).toBe(retried ? 2 : 0);
            expect(listings).toBe(
              column === "failed-other-shaped-running" && name !== "observe" ? 0 : retried ? 3 : 1,
            );
            if (column === "failed-other-unknown") {
              expect(h.ensure).not.toHaveBeenCalled();
              expect(h.verify).not.toHaveBeenCalled();
              expect(h.runs).toEqual([]);
            }
          }
          if (exactRunningPin) {
            expect(listings).toBe(0);
            expect(retryTimer.now()).toBe(0);
            expect(retryTimer.getSleepCallCount()).toBe(0);
            expect(h.timer.now()).toBe(0);
            expect(h.timer.getSleepCallCount()).toBe(0);
            expect(h.detect).toHaveBeenCalledTimes(1);
            expect(h.handledDevices).toEqual([h.device]);
          }
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
          if (column !== "stopped" && column !== "failed-other-stopped") {
            expect(h.boots.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(0);
          }
          if (column.startsWith("reserved") || column === "failed-other-reserved") {
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
      test(`${platform} ${columnLabel}, platform=${requested ?? "absent"}: every tool reaches an identical decision`, () => {
        const row =
          decisions.get(`${platform}:${columnLabel}:${requested ?? "absent"}`) ??
          new Map<string, string>();
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
}

const probeColumns = [
  "probe-running-name",
  "probe-held-name",
  "probe-unresolved",
  "probe-stopped-name",
  "probe-running-id",
] as const;

function installProbeInventory(column: (typeof probeColumns)[number]): void {
  const current = h!;
  const stopped = column === "probe-stopped-name";
  const raw: BootedDevice = {
    platform: "android",
    deviceId: stopped ? "emulator-5554" : current.device.deviceId,
    name: stopped ? "emulator-5554" : current.device.deviceId,
    observedAt: 1,
  };
  current.devices.splice(0, current.devices.length, raw);
  current.adb.setDevices([raw]);
  current.discovery.setBootedDevices("android", [raw]);
  const start = current.discovery.startDevice.bind(current.discovery);
  current.discovery.startDevice = async (...args) => {
    const device = await start(...args);
    const booted = (await current.adb.getBootedAndroidDevices()).map((row) => ({
      ...row,
      name: row.deviceId,
    }));
    current.adb.setDevices(booted);
    current.discovery.setBootedDevices("android", booted);
    return device;
  };
  current.adb.setCommandResponse(
    "emu avd name",
    createExecResult(
      column === "probe-unresolved" ? "" : stopped ? "Other_AVD\nOK" : "Named_Pixel\nOK",
      "",
    ),
  );
  const client = new AndroidEmulatorClient(
    null,
    null,
    current.timer,
    new FakeAdbClientFactory(current.adb),
  );
  const inventory = new MultiPlatformDeviceManager(
    current.adb,
    current.simctl as unknown as SimCtlClient,
    client,
    new FakeVirtualDeviceLifecycleCoordinator(),
    current.timer,
  );
  const restoreFactory = snapshotPlatformDeviceManagerFactory();
  const previousInstance = Reflect.get(PlatformDeviceManagerFactory, "instance");
  const previousInjectedManager = Reflect.get(PlatformDeviceManagerFactory, "injectedManager");
  PlatformDeviceManagerFactory.setInstance(inventory);
  statusListing = () => listBootedDevicesForReadWithStatus("android", "read-rule-probe");
  restoreProbeInventory = async () => {
    try {
      // Prove clearing enrichment state forces a probe for every remaining emulator.
      await client.getBootedDevicesChecked(false, {
        coalesceInventoryEnrichment: true,
        readinessOnly: true,
      });
      const before = current.adb.getExecutedCommands().filter((c) => c === "emu avd name").length;
      resetAndroidInventoryEnrichmentCache();
      await client.getBootedDevicesChecked(false, {
        coalesceInventoryEnrichment: true,
        readinessOnly: true,
      });
      expect(current.adb.getExecutedCommands().filter((c) => c === "emu avd name").length).toBe(
        before + (await current.adb.getBootedAndroidDevices()).length,
      );
    } finally {
      resetAndroidInventoryEnrichmentCache();
      restoreFactory();
      expect(Reflect.get(PlatformDeviceManagerFactory, "instance")).toBe(previousInstance);
      expect(Reflect.get(PlatformDeviceManagerFactory, "injectedManager")).toBe(
        previousInjectedManager,
      );
    }
  };
}

for (const column of probeColumns) {
  for (const name of EXPECTED) {
    test(`android ${column}: ${name}`, async () => {
      const stopped = column === "probe-stopped-name";
      const held = column === "probe-held-name";
      h = harness("android", !stopped);
      installProbeInventory(column);
      Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
      const daemon = (held ? owners : unheld).get("android")!;
      DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
      const before = structuredClone(daemon.sessions.getAllSessions());
      const id = column === "probe-running-id" ? h.device.deviceId : h.device.name;
      const execution = executionTracker.startExecution(name);
      let decision: string;
      try {
        // The serial fast path is the generic resolver contract, including observe outside its explicit context.
        await runWithToolSelectionContext(
          { explicitObserveDeviceRead: name === "observe" && column !== "probe-running-id" },
          () =>
            ToolRegistry.getTool(name)!.handler({
              platform: "android",
              deviceId: id,
              ...readArgs[name],
              [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
              [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
            }),
        );
        decision = `device:${h.runs[0]?.deviceId};boots:${h.boots.length}`;
      } catch (error) {
        expect(error).toBeInstanceOf(ActionableError);
        const code: unknown = Reflect.get(error as Error, "code");
        decision = typeof code === "string" ? code : (error as Error).message;
      } finally {
        executionTracker.endExecution(execution.id);
      }
      const row = decisions.get(column) ?? new Map<string, string>();
      row.set(name, decision);
      decisions.set(column, row);
      expect(decision).toBe(
        column === "probe-unresolved"
          ? "discovery_incomplete"
          : `device:${h.device.deviceId};boots:${stopped ? 1 : 0}`,
      );
      const probes = h.adb.getExecutedCommands().filter((c) => c === "emu avd name");
      expect(probes).toHaveLength(column === "probe-running-id" ? 0 : 1);
      expect(h.boots).toHaveLength(stopped ? 1 : 0);
      expect(h.manager.getCurrentDevice()).toBeUndefined();
      expect(h.manager.getCurrentPlatform()).toBeUndefined();
      expect(h.manager.getExplicitDevicePin()).toBeUndefined();
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.getConfig).not.toHaveBeenCalled();
      expect(
        h.adb.getExecutedCommands().filter((c) => /settings (put|delete)|cmd uimode/.test(c)),
      ).toEqual([]);
      expect(daemon.sessions.getAllSessions()).toEqual(before);
      if (h.runs.length) {
        expect(h.runs[0].sessionUuid).toBeUndefined();
      }
      if (held) {
        expect(h.runs[0].readPath).toBe(true);
        expect(h.ensure).not.toHaveBeenCalled();
        expect(h.verify).not.toHaveBeenCalled();
      } else if (!stopped && column !== "probe-unresolved" && name !== "observe") {
        expect(h.detect).toHaveBeenCalledTimes(1);
        expect(h.ensure.mock.calls[0][1]).toBe(h.device.deviceId);
      }
    });
  }
  test(`android ${column}: every tool reaches an identical decision`, () => {
    const row = decisions.get(column) ?? new Map<string, string>();
    expect(new Set(row.values()).size).toBe(row.size ? 1 : 0);
    if (row.size === EXPECTED.length) {
      expect([...row.keys()].sort()).toEqual(EXPECTED);
    }
  });
}

test("a probed serial missing from the memoized raw scan is refreshed before readiness", async () => {
  h = harness("android", true);
  installProbeInventory("probe-running-name");
  Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
  const daemon = unheld.get("android")!;
  DaemonState.getInstance().initialize(daemon.sessions, daemon.pool);
  let scans = 0;
  h.detect.mockImplementation(async () => ({
    devices: ++scans === 1 ? [] : h!.devices,
    scanned: { android: true, ios: true },
  }));
  await ToolRegistry.getTool("listApps")!.handler({ platform: "android", deviceId: h.device.name });
  expect(h.runs).toEqual([
    { deviceId: h.device.deviceId, sessionUuid: undefined, readPath: false },
  ]);
  expect(h.detect).toHaveBeenCalledTimes(2);
  expect(h.ensure.mock.calls[0][1]).toBe(h.device.deviceId);
  expect(h.adb.getExecutedCommands().filter((c) => c === "emu avd name")).toHaveLength(1);
  expect(h.boots).toEqual([]);
  expect(daemon.sessions.getAllSessions()).toEqual([]);
  expect(h.manager.getCurrentDevice()).toBeUndefined();
  expect(h.manager.getCurrentPlatform()).toBeUndefined();
  expect(h.manager.getExplicitDevicePin()).toBeUndefined();
  expect(h.apply).not.toHaveBeenCalled();
});

test("a serial acquired during discovery is rechecked before readiness", async () => {
  h = harness("android", true);
  Reflect.set(ToolRegistry, "deviceSessionManager", h.manager);
  DaemonState.getInstance().initialize(slotOwner.sessions, slotOwner.pool);
  let acquired = false;
  let listings = 0;
  const listedDevice = { ...h.device, name: "Funnelled_Pixel" };
  statusListing = async () => {
    listings++;
    return { devices: [listedDevice], scanned: { android: true, ios: true } };
  };
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
    expect(listings).toBe(1);
    expect(h.handledDevices).toEqual([listedDevice]);
    expect(h.handledDevices[0]).toBe(listedDevice);
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
        const claim = () => {
          claimed = true;
          if (platform === "android" && kind === "holder") {
            h!.devices.splice(0, h!.devices.length, h!.device);
            h!.adb.setDevices([h!.device]);
            h!.discovery.setBootedDevices("android", [h!.device]);
            h!.discovery.setDeviceImages("android", [
              { name: h!.device.name, platform, isRunning: true, source: "local" },
            ]);
          }
        };
        if (phase === "scan") {
          h.detect.mockImplementation(async () => {
            claim();
            return { devices: h!.devices, scanned: { android: true, ios: true } };
          });
        } else if (platform === "android") {
          const list = h.discovery.listDeviceImages.bind(h.discovery);
          h.discovery.listDeviceImages = async (...args) => {
            const images = await list(...args);
            claim();
            return images;
          };
        } else {
          const list = h.simctl.listSimulatorImages.bind(h.simctl);
          h.simctl.listSimulatorImages = async (...args) => {
            claim();
            return list(...args);
          };
        }
        const originalHolder = slotOwner.sessions.getSessionForDevice;
        const originalReservation = slotOwner.pool.restartReservationForStart;
        const holder = spyOn(slotOwner.sessions, "getSessionForDevice").mockImplementation(
          (target) =>
            claimed && kind === "holder" && target === h!.device.deviceId ? "late-owner" : null,
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
          } else if (platform === "android") {
            expect(h.runs).toEqual([
              { deviceId: h.device.deviceId, sessionUuid: undefined, readPath: true },
            ]);
          } else {
            expect(result).toMatchObject({
              message: `Device ${id} not found on ${platform} platform. Available ${platform} devices: none`,
            });
          }
          expect(h.boots).toEqual([]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
          expect(h.verify).not.toHaveBeenCalled();
          if (platform !== "android" || kind !== "holder") {
            expect(h.runs).toEqual([]);
          }
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
  name: string,
  scenario: "stopped" | "unknown" | "reserved" | "running",
  requested?: "either",
  failedOther = false,
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
      discoveryErrors: {
        [other]: failedOther
          ? { code: "failed", message: other === "android" ? "adb died" : "simctl died" }
          : { code: "unavailable", message: "tooling absent" },
      },
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
  expect(retryTimer.getPendingTimeoutCount()).toBe(0);
  expect(retryTimer.getPendingSleepCount()).toBe(0);
  const retried = failedOther && (scenario === "unknown" || scenario === "reserved");
  expect(retryTimer.now()).toBe(retried ? 1000 : 0);
  expect(retryTimer.getSleepCallCount()).toBe(retried ? 2 : 0);
  let decision: string;
  if (scenario === "reserved") {
    expect(result).toMatchObject({ code: "device_owned_by_other_session", retryAfterMs: 500 });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.boots).toEqual([]);
    expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
    decision = "device_owned_by_other_session";
  } else if (scenario === "unknown") {
    // A failed platform cannot be ruled out for a bare name without a healthy match.
    expect(result).toMatchObject({ code: "discovery_incomplete", platform: other });
    expect(h.runs).toEqual([]);
    expect(h.boots).toEqual([]);
    expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
    if (failedOther) {
      expect(h.ensure).not.toHaveBeenCalled();
    }
    decision = "discovery_incomplete";
  } else {
    expect(result).not.toBeInstanceOf(Error);
    expect(h.runs).toHaveLength(1);
    decision = `device:${h.runs[0].deviceId};boots:${h.boots.length + h.simctl.getMethodCalls("bootSimulator").length}`;
    expect(decision).toBe(`device:${h.device.deviceId};boots:${scenario === "stopped" ? 1 : 0}`);
    expect(h.runs[0].sessionUuid).toBeUndefined();
    expect(h.ensure).toHaveBeenCalledTimes(name === "observe" && scenario === "running" ? 0 : 1);
  }
  expect(daemon.sessions.getAllSessions()).toEqual([]);
  expect(h.manager.getCurrentDevice()).toBeUndefined();
  expect(h.manager.getCurrentPlatform()).toBeUndefined();
  expect(h.manager.getExplicitDevicePin()).toBeUndefined();
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.getConfig).not.toHaveBeenCalled();
  expect(
    h.adb.getExecutedCommands().filter((c) => /settings (put|delete)|cmd uimode/.test(c)),
  ).toEqual([]);
  if (failedOther) {
    expect(listings).toBe(retried ? 3 : 1);
    return { decision, listings };
  }
  expect(listings).toBe(
    scenario === "reserved"
      ? name === "observe"
        ? 2
        : 1
      : name === "observe" || scenario !== "running" || platform === "android"
        ? 1
        : 0,
  );
  return { decision, listings };
}

for (const platform of ["android", "ios"] as const) {
  for (const requested of [undefined, "either"] as const) {
    for (const name of ["listApps", "getDeviceState", "observe"] as const) {
      test(`${platform} failed-other stopped ${name}, platform=${requested ?? "absent"}`, async () => {
        await onePlatformDecision(platform, name, "stopped", requested, true);
      });
    }
    test(`${platform} failed-other reserved listApps, platform=${requested ?? "absent"}`, async () => {
      await onePlatformDecision(platform, "listApps", "reserved", requested, true);
    });
  }
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

// Direct shared-resolver pins: both findRunning and resolve scope shaped ids, but an
// explicit contradictory platform still wins over the shape.
for (const platform of ["android", "ios"] as const) {
  const id = platform === "android" ? "emulator-5599" : "87654321-ABCD-ABCD-ABCD-123456789ABC";
  const other = platform === "android" ? "ios" : "android";
  for (const requested of [undefined, "either"] as const) {
    for (const running of [false, true]) {
      test(`${platform} shaped resolver ${running ? "running" : "absent"}, platform=${requested ?? "absent"}: no other-platform retry`, async () => {
        const timer = new FakeTimer();
        const device = { ...deviceFor(platform), deviceId: id };
        const list = mock(async () => ({
          devices: running ? [device] : [],
          scanned: { android: platform === "android", ios: platform === "ios" },
          discoveryErrors: { [other]: { code: "failed" as const, message: "other failed" } },
        }));
        const access = {
          listBooted: async () => [],
          listBootedWithStatus: list,
          isAuthorized: () => true,
        };
        expect(
          await sessionlessDeviceReadFor(access, { timer }).findRunning(id, undefined, requested),
        ).toEqual(running ? device : undefined);
        expect(list).toHaveBeenCalledTimes(1);
        list.mockClear();
        if (running) {
          expect(
            await resolveDeviceForObservationRead(id, undefined, access, requested, { timer }),
          ).toEqual(device);
        } else {
          await expect(
            resolveDeviceForObservationRead(id, undefined, access, requested, { timer }),
          ).rejects.toThrow(`Device ${id} not found`);
        }
        expect(list).toHaveBeenCalledTimes(1);
        expect(timer.now()).toBe(0);
        expect(timer.getSleepCallCount()).toBe(0);
      });
    }
  }
  test(`${platform} shaped resolver honors a contradictory explicit platform`, async () => {
    const timer = new FakeTimer();
    const list = mock(async () => ({
      devices: [{ ...deviceFor(platform), deviceId: id }],
      scanned: { android: true, ios: true },
    }));
    const access = {
      listBooted: async () => [],
      listBootedWithStatus: list,
      isAuthorized: () => true,
    };
    await expect(
      resolveDeviceForObservationRead(id, undefined, access, other, { timer }),
    ).rejects.toThrow(`not found on ${other} platform`);
    expect(list).toHaveBeenCalledTimes(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
}

for (const platform of ["android", "ios"] as const) {
  for (const phase of platform === "android" ? ["lease wait", "cold boot"] : ["lease wait"]) {
    for (const acquisition of [
      "held",
      ...(platform === "android" ? ["during ownership" as const] : []),
      "during verify",
      "verify returns",
      "caller abort",
    ] as const) {
      test(`${platform}: read by stopped image ${platform === "android" ? "name" : "UDID"} ${phase}, ${acquisition} watches or cancels`, async () => {
        h = harness(platform, false);
        const current = h;
        Reflect.set(ToolRegistry, "deviceSessionManager", current.manager);
        DaemonState.getInstance().initialize(slotOwner.sessions, slotOwner.pool);
        const { device, lifecycle } = current;
        const identity = {
          kind: "stable" as const,
          platform,
          stableId: platform === "android" ? device.name : device.deviceId,
        };
        const blocker =
          phase === "lease wait"
            ? await lifecycle.reserve(identity, { operation: "start", deadlineMs: 300_000 })
            : undefined;
        let bound = false;
        const holder = spyOn(slotOwner.sessions, "getSessionForDevice").mockImplementation(
          (target) => {
            if (
              acquisition === "during ownership" &&
              !bound &&
              target === device.deviceId &&
              execution.sessionlessDeviceUse?.has(device.deviceId)
            ) {
              bound = true;
              seen.push({
                marks: [...execution.sessionlessDeviceUse],
                cancelled: executionTracker.cancelSessionlessDeviceUse(device.deviceId),
                aborted: execution.abortController.signal.aborted,
              });
              return null;
            }
            return bound && target === device.deviceId ? "late-owner" : null;
          },
        );
        const publish = () => {
          if (platform === "android") {
            statusListing = async () => {
              throw new Error("resolved watch must not rediscover the serial");
            };
          }
          current.devices.splice(0, current.devices.length, device);
          if (platform === "android") {
            current.adb.setDevices([device]);
            current.discovery.setBootedDevices("android", [device]);
            current.discovery.setDeviceImages("android", [
              { name: device.name, platform, isRunning: true, source: "local" },
            ]);
          } else {
            current.simctl.setAvailableSimulators([{ ...device, isRunning: true }]);
            current.simctl.setBootedSimulators([device]);
          }
          bound = acquisition === "held";
        };
        if (phase === "cold boot") {
          const wait = current.discovery.waitForDeviceReady.bind(current.discovery);
          current.discovery.waitForDeviceReady = async (...args) => {
            const booted = await wait(...args);
            publish();
            return booted;
          };
        }
        const execution = executionTracker.startExecution("listApps");
        const callerFailure = new ActionableError("caller cancelled readiness");
        const realVerify = DeviceSessionManager.prototype.verifyDevice.bind(current.manager);
        const seen: Array<{ marks: string[]; cancelled: number; aborted: boolean }> = [];
        const readinessAmbientAborted: Array<boolean | undefined> = [];
        const verify = async (...args: Parameters<typeof realVerify>) => {
          expect(args[0]).toBe(device.deviceId);
          const marks = [...(execution.sessionlessDeviceUse ?? [])];
          if (acquisition === "caller abort") {
            execution.abortController.abort(callerFailure);
          } else {
            bound = true;
            const cancelled = executionTracker.cancelSessionlessDeviceUse(device.deviceId);
            seen.push({ marks, cancelled, aborted: execution.abortController.signal.aborted });
            expect(cancelled).toBe(1);
            readinessAmbientAborted.push(getAbortSignal()?.aborted);
            expect(getAbortSignal()?.aborted).toBe(true);
            expect(execution.abortController.signal.aborted).toBe(false);
          }
          if (acquisition === "verify returns") {
            return;
          }
          if (phase === "cold boot") {
            await DeviceSessionManager.prototype.verifyAndroidDevice.call(
              current.manager,
              args[0],
              args[2],
              args[3],
            );
          } else {
            await realVerify(...args);
          }
        };
        const coldVerify =
          phase === "cold boot"
            ? spyOn(current.manager, "verifyAndroidDevice").mockImplementation(
                (id, options, resolved) => verify(id, "android", options, resolved),
              )
            : undefined;
        if (!coldVerify) {
          current.verify.mockImplementation(verify);
        }
        const shutdown = spyOn(current.discovery, "killDevice");
        try {
          const outcome = runWithAbortSignal(execution.abortController.signal, () =>
            ToolRegistry.getTool("listApps")!.handler(
              {
                platform,
                deviceId: platform === "android" ? device.name : device.deviceId,
                [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
                [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
              },
              undefined,
              execution.abortController.signal,
            ),
          );
          // Attach rejection handling before releasing the fake lifecycle barrier.
          const result = outcome.then(
            () => undefined,
            (error: unknown) => error,
          );
          if (blocker) {
            await drainUntil(() => lifecycle.reservations.length === 2, {
              description: "read queued on image lifecycle lease",
            });
            publish();
            blocker.release();
          }
          if (acquisition === "caller abort") {
            expect(await result).toBe(callerFailure);
            expect(current.runs).toEqual([]);
          } else {
            expect(await result).toBeUndefined();
            expect(current.runs).toEqual([
              { deviceId: device.deviceId, sessionUuid: undefined, readPath: true },
            ]);
            expect(current.handlerSignals).toEqual([execution.abortController.signal]);
            expect(current.handlerSignals[0]?.aborted).toBe(false);
            if (acquisition === "during verify" || acquisition === "verify returns") {
              expect(readinessAmbientAborted).toEqual([true]);
            }
            if (acquisition === "held" || acquisition === "during ownership") {
              expect(current.verify).not.toHaveBeenCalled();
              expect(coldVerify?.mock.calls.length ?? 0).toBe(0);
            }
            if (acquisition !== "held") {
              expect(seen).toEqual([{ marks: [device.deviceId], cancelled: 1, aborted: false }]);
            }
          }
          expect(current.boots).toHaveLength(phase === "cold boot" ? 1 : 0);
          expect(current.simctl.getMethodCalls("bootSimulator")).toEqual([]);
          expect(shutdown).not.toHaveBeenCalled();
          expect(lifecycle.isReserved(identity)).toBe(false);
          expect(execution.sessionlessDeviceUse?.size ?? 0).toBe(0);
          expect(
            current.adb
              .getExecutedCommands()
              .filter((c) => /settings (put|delete)|cmd uimode/.test(c)),
          ).toEqual([]);
          expect(current.manager.getCurrentDevice()).toBeUndefined();
        } finally {
          blocker?.release();
          executionTracker.endExecution(execution.id);
          holder.mockRestore();
          coldVerify?.mockRestore();
          shutdown.mockRestore();
        }
      });
    }
  }
}
