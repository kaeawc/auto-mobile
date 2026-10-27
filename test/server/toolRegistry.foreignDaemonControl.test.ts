import { afterEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/models/deviceAcquisitionRefusals";
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
import {
  ToolRegistry,
  type AuditRunnerInput,
  type ToolRegistryCollaborators,
} from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

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
  let originals: ToolRegistryCollaborators;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let readinessRequests: number;
  let devices: FakeDeviceReadiness;
  let fakeDeviceUtils: FakeDeviceUtils;
  let visibleDevices: BootedDevice[];

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  const refusal = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    call(name, args).then(
      () => undefined,
      (error: unknown) => error,
    );

  async function arrangeHarness(): Promise<void> {
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
    devices = new FakeDeviceReadiness();
    devices.setConnectedDevices([claimed, free]);
    devices.setExplicitDevicePin(claimed);
    readinessRequests = 0;
    const ensureDeviceReady = devices.ensureDeviceReady.bind(devices);
    devices.ensureDeviceReady = async (...args) => {
      readinessRequests++;
      return await ensureDeviceReady(...args);
    };
    originals = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: devices });
    ToolRegistry.setCollaboratorsForTesting({
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    ToolRegistry.setCollaboratorsForTesting({
      navigationToolCallRecorder: { record: () => undefined },
    });

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
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  function arrangedEach(table: Array<[string, Record<string, unknown>]>) {
    return (
      name: string,
      fn: (name: string, args: Record<string, unknown>) => void | Promise<void>,
      timeout?: number,
    ): void => {
      test.each(table)(
        name,
        async (tool, args) => {
          await arrangeHarness();
          await fn(tool, args);
        },
        timeout,
      );
    };
  }

  afterEach(() => {
    restorePipeline();
    ToolRegistry.setCollaboratorsForTesting(originals);
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
    arranged(
      `a sessionless ${name} on the claimed device is refused before readiness or the handler`,
      async () => {
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
      },
    );
  }

  arranged("a sessionless control call on a device no daemon claims still runs", async () => {
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  arranged("the same control call runs once the other daemon's claim is gone", async () => {
    foreignOwners.clear();
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: claimed.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: claimed.deviceId }]);
  });

  arranged("a read of the claimed device is never refused", async () => {
    await call("observe", { platform: "android", deviceId: claimed.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: claimed.deviceId }]);
  });

  arrangedEach([
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

  arranged("#12220 explicit tapOn reports foreign PID and release remedy", async () => {
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
    expect(String(error)).toContain("Retry after that daemon releases it, or pick another device.");
    expect(ran).toEqual([]);
    expect(readinessRequests).toBe(0);
  });

  arranged("#12220 unknown forwarded port refuses control while observe watches", async () => {
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

  arranged("#12220 foreign forward remains watchable through observe", async () => {
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

  arranged(
    "F6a no current device or pin and one foreign running device refuses tapOn {} while observe {} watches",
    async () => {
      onlyClaimedVisible();
      foreignOwners.clear();
      devices.clearExplicitDevicePin(claimed.deviceId);
      expect(devices.getExplicitDevicePin()).toBeUndefined();
      forwardVerdict = {
        kind: "foreign",
        ports: [8767],
        clientPids: [FOREIGN_PID],
        message: "foreign driver",
      };
      const error = await refusal("tapOn", {});
      expect(error).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        deviceId: claimed.deviceId,
        ownerPid: FOREIGN_PID,
      });
      expect(String(error)).toContain(
        "the device it would use is driven by another AutoMobile daemon",
      );
      expect(String(error)).not.toContain("the only candidate");
      expect(readinessRequests).toBe(0);
      expect(ran).toEqual([]);
      await call("observe", {});
      expect(readinessRequests).toBe(0);
      expect(ran).toEqual([{ name: "observe", deviceId: claimed.deviceId }]);
    },
  );

  arranged("#12220 no forward admits unnamed control", async () => {
    onlyClaimedVisible();
    foreignOwners.clear();
    await call("tapOn", { text: "OK", action: "tap", platform: "android" });
    expect(ran).toEqual([{ name: "tapOn", deviceId: claimed.deviceId }]);
  });
});
