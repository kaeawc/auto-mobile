import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import type { ForeignCtrlProxyForwardVerdict } from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

/**
 * #11349 (owner decision 2026-10-10): a sessionless control call on a device another daemon has
 * claimed is refused with the typed `device_owned_by_other_daemon` before readiness or the handler
 * runs. The pool saw such a device as free: it has no local session. Reads stay open. The real
 * `rotate`, `tapOn` and `observe` registrations run through the real ToolRegistry resolution; a
 * fake audit runner records an admitted call instead of touching a device.
 */
describe("ToolRegistry control on a device another daemon claims (#11349)", () => {
  const claimed: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const FOREIGN_PID = 4242;

  let ran: Array<{ name: string; deviceId: string }>;
  let foreignOwners: Map<string, number>;
  let forwardVerdict: ForeignCtrlProxyForwardVerdict;
  let originals: Array<[string, unknown]>;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let readinessRequests: number;
  let devices: FakeDeviceSessionManager;
  let fakeDeviceUtils: FakeDeviceUtils;
  let visibleDevices: BootedDevice[];

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  const refusal = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    call(name, args).then(
      () => undefined,
      (error: unknown) => error,
    );

  beforeEach(async () => {
    ran = [];
    foreignOwners = new Map([[claimed.deviceId, FOREIGN_PID]]);
    forwardVerdict = { kind: "none" };
    ToolRegistry.clearTools();
    visibleDevices = [claimed, free];
    const deviceReadAccess = { listBooted: async () => visibleDevices, isAuthorized: () => true };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess,
      auditRunner: {
        async run(input: AuditRunnerInput) {
          ran.push({ name: input.name, deviceId: input.device.deviceId });
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
    devices.setConnectedDevices([claimed, free]);
    devices.setCurrentDevice(claimed, "android");
    readinessRequests = 0;
    const ensureDeviceReady = devices.ensureDeviceReady.bind(devices);
    devices.ensureDeviceReady = async (...args) => {
      readinessRequests++;
      return await ensureDeviceReady(...args);
    };
    originals = (
      ["deviceSessionManager", "toolCallRepository", "navigationToolCallRecorder"] as const
    ).map((key) => [key, Reflect.get(ToolRegistry, key)]);
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [claimed, free]);
    const files: DeviceOwnershipFileSource = {
      leasePath: () => undefined,
      claimPath: (deviceId) => `/claims/${deviceId}`,
      legacyClaimPath: () => undefined,
      read: (path) => {
        const pid = foreignOwners.get(path.slice("/claims/".length));
        return pid === undefined ? undefined : { pid, token: "peer" };
      },
      isProcessRunning: (pid) => pid === FOREIGN_PID,
      tryAcquire: () => true,
      takeOver: () => true,
      release: () => {},
    };
    const foreignDeviceOwnership = new ForwardLeaseForeignDeviceOwnership(
      100,
      files,
      { query: async () => ({ kind: "unreachable", detail: "unused" }) },
      () => undefined,
      timer,
      { read: async () => forwardVerdict },
    );
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "foreign-daemon-control", {
        timer,
        deviceManager: fakeDeviceUtils,
        foreignDeviceOwnership,
      }),
    );
    await pool.initializeWithDevices([claimed, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);

    registerInteractionTools();
    registerObserveTools({
      deviceReadAccess,
      createScreen: (device) => ({
        executeDeviceRead: async () => {
          ran.push({ name: "observe", deviceId: device.deviceId });
          return loadAndroidHomeObserve().observe;
        },
        execute: async () => {
          ran.push({ name: "observe", deviceId: device.deviceId });
          return loadAndroidHomeObserve().observe;
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
      }),
    });
  });

  afterEach(() => {
    restorePipeline();
    for (const [key, value] of originals) {
      Reflect.set(ToolRegistry, key, value);
    }
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  const controlCalls: Array<[string, Record<string, unknown>]> = [
    ["rotate", { orientation: "landscape" }],
    ["tapOn", { text: "OK", action: "tap" }],
  ];

  const onlyClaimedVisible = () => {
    visibleDevices = [claimed];
    devices.setConnectedDevices([claimed]);
    fakeDeviceUtils.setBootedDevices("android", [claimed]);
  };

  for (const [name, args] of controlCalls) {
    test(`a sessionless ${name} on the claimed device is refused before readiness or the handler`, async () => {
      const error = await refusal(name, {
        ...args,
        platform: "android",
        deviceId: claimed.deviceId,
      });

      expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(error).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        retryable: true,
        deviceId: claimed.deviceId,
        ownerPid: FOREIGN_PID,
      });
      expect(ran).toEqual([]);
      expect(readinessRequests).toBe(0);
    });
  }

  test("a sessionless control call on a device no daemon claims still runs", async () => {
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  test("the same control call runs once the other daemon's claim is gone", async () => {
    foreignOwners.clear();
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: claimed.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: claimed.deviceId }]);
  });

  test("a read of the claimed device is never refused", async () => {
    await call("observe", { platform: "android", deviceId: claimed.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: claimed.deviceId }]);
  });

  test.each([
    ["tapOn", { text: "OK", action: "tap" }],
    ["rotate", { orientation: "landscape" }],
  ])(
    "#12220 unnamed %s refuses a foreign forward before readiness and handler",
    async (name, args) => {
      onlyClaimedVisible();
      foreignOwners.clear();
      forwardVerdict = {
        kind: "foreign",
        ports: [19001],
        clientPids: [FOREIGN_PID],
        message: "foreign CtrlProxy forward",
      };
      const error = await refusal(name, { ...args, platform: "android" });
      expect(error).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        ownerPid: FOREIGN_PID,
        deviceId: claimed.deviceId,
      });
      expect(String(error)).toContain("pass the deviceId");
      expect(String(error)).toContain("getAndroid/getApple");
      expect(ran).toEqual([]);
      expect(readinessRequests).toBe(0);
    },
  );

  test("#12220 explicit tapOn reports foreign PID and acquisition remedy", async () => {
    foreignOwners.clear();
    forwardVerdict = {
      kind: "foreign",
      ports: [19001],
      clientPids: [FOREIGN_PID],
      message: "foreign CtrlProxy forward",
    };
    const error = await refusal("tapOn", {
      text: "OK",
      action: "tap",
      platform: "android",
      deviceId: claimed.deviceId,
    });
    expect(error).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      ownerPid: FOREIGN_PID,
    });
    expect(String(error)).toContain("setActiveDevice");
    expect(ran).toEqual([]);
    expect(readinessRequests).toBe(0);
  });

  test("#12220 unknown forwarded port refuses control while observe watches", async () => {
    foreignOwners.clear();
    forwardVerdict = {
      kind: "unknown",
      ports: [19001],
      reason: "pid unavailable",
      message: "unknown forward owner",
    };
    const error = await refusal("tapOn", {
      text: "OK",
      action: "tap",
      platform: "android",
      deviceId: claimed.deviceId,
    });
    expect(error).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      ownerPid: undefined,
    });
    expect(readinessRequests).toBe(0);
    await call("observe", { platform: "android", deviceId: claimed.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: claimed.deviceId }]);
    expect(readinessRequests).toBe(0);
  });

  test("#12220 foreign forward remains watchable through observe", async () => {
    foreignOwners.clear();
    forwardVerdict = {
      kind: "foreign",
      ports: [19001],
      clientPids: [FOREIGN_PID],
      message: "foreign CtrlProxy forward",
    };
    onlyClaimedVisible();
    await call("observe", { platform: "android", deviceId: claimed.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: claimed.deviceId }]);
    expect(readinessRequests).toBe(0);
  });

  test("#12220 no forward admits unnamed control", async () => {
    onlyClaimedVisible();
    foreignOwners.clear();
    await call("tapOn", { text: "OK", action: "tap", platform: "android" });
    expect(ran).toEqual([{ name: "tapOn", deviceId: claimed.deviceId }]);
  });
});
