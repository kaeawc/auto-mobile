import { describe, expect } from "bun:test";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager } from "../../src/daemon/sessionManager";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { restartResumeSessionForDevice } from "../../src/server/deviceToolsStartDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

// Fixture follows test/server/restartReservationStartAdmission.test.ts.
const HOLDER = "restart-holder";
const CONNECTION = "holder-connection";
interface Internals {
  releaseDisconnectedRecoverySessionWithRetry(
    id: string,
    deviceId: string,
    reason: SessionReleaseReason,
  ): Promise<void>;
  rehydrationReservations: Map<string, { restartHandoff?: boolean; deviceId: string }>;
}

class RestartDeviceManager extends FakeDeviceUtils {
  /** A stopped AVD has no serial; the emulator takes the lowest free console port at boot. */
  override async startDevice(...args: Parameters<FakeDeviceUtils["startDevice"]>) {
    const [image, timeoutMs] = args;
    return super.startDevice(
      image.deviceId ? image : { ...image, deviceId: "emulator-5554" },
      timeoutMs,
    );
  }
  override async waitForDeviceReady(...args: Parameters<FakeDeviceUtils["waitForDeviceReady"]>) {
    const [image, ...rest] = args;
    return super.waitForDeviceReady(
      image.deviceId ? image : { ...image, deviceId: "emulator-5554" },
      ...rest,
    );
  }
  override async killDevice(device: BootedDevice) {
    await super.killDevice(device);
    this.setBootedDevices(device.platform, []);
  }
}

describe("restart-hold owner starts a different AVD that boots on the reserved serial", () => {
  const cleanups: Array<() => void> = [];
  const test = warmedTests(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    resetDbWriteBarrier();
  });

  async function fixture(managedSlotExclusion?: DevicePoolDependencies["managedSlotExclusion"]) {
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const manager = new RestartDeviceManager();
    const device: BootedDevice = {
      platform: "android",
      name: "restart-phone",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = { ...device, source: "local", isRunning: false };
    manager.setBootedDevices("android", [device]);
    manager.setDeviceImages("android", [image]);
    manager.setMockChildProcess(device.name, null);
    const persistence = new FakeDeviceSessionPersistence();
    const sessions = new SessionManager(
      timer,
      persistence,
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
    );
    sessions.attachDaemonSessionId("restart-start-daemon");
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "restart-start-daemon", {
        env,
        managedSlotExclusion,
        timer,
        deviceManager: manager,
        emulatorLossIncidentStore: new InMemoryEmulatorLossIncidentStore(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        idGenerator: new FakeIdGenerator([]),
      }),
    );
    const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    const previousSessionManager: unknown = Reflect.get(ToolRegistry, "deviceSessionManager");
    const previousToolCalls: unknown = Reflect.get(ToolRegistry, "toolCallRepository");
    const deviceSessions = new FakeDeviceSessionManager();
    deviceSessions.setConnectedDevices([device]);
    Reflect.set(ToolRegistry, "deviceSessionManager", deviceSessions);
    Reflect.set(ToolRegistry, "toolCallRepository", { recordToolCall: async () => {} });
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      restorePipeline();
      Reflect.set(ToolRegistry, "deviceSessionManager", previousSessionManager);
      Reflect.set(ToolRegistry, "toolCallRepository", previousToolCalls);
    });
    setDeviceToolsDependencies({
      env,
      timer,
      idGenerator: new FakeIdGenerator(),
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
    });
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessions, pool);
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      device.deviceId,
      "android",
      undefined,
      undefined,
      device,
      false,
      undefined,
      undefined,
      undefined,
      CONNECTION,
    );
    const live = sessions.getSession(HOLDER)!;
    live.expiresAt = timer.now() + 600_000;
    live.sessionTimeoutMs = 600_000;
    const liveRow = (await persistence.getSession!(HOLDER))!;
    liveRow.expires_at_ms = live.expiresAt;
    liveRow.session_timeout_ms = live.sessionTimeoutMs;
    const internals = pool as unknown as Internals;
    // restart-phone's emulator dies: HOLDER is handed off with the 180 s restart hold and the
    // serial emulator-5554 leaves the pool (its console port is now free).
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      HOLDER,
      device.deviceId,
      `device-restart:${device.name}`,
    );
    await pool.releaseDevice(device.deviceId, HOLDER);
    manager.setBootedDevices("android", []);
    await pool.removeDevice(device.deviceId, true, pool.getDevice(device.deviceId));
    await drainMicrotasks();
    registerDeviceTools();
    manager.clearHistory();
    // A second, stopped AVD. The emulator takes the lowest free console port, so its boot lands
    // on the serial the dead device just vacated.
    const other: DeviceInfo = {
      platform: "android",
      name: "other-phone",
      source: "local",
      isRunning: false,
    };
    manager.setDeviceImages("android", [image, other]);
    manager.setMockChildProcess(other.name, null);
    const start = (args: Record<string, unknown>, routingSessionUuid?: string) =>
      runWithToolSelectionContext({ routingSessionUuid }, () =>
        ToolRegistry.getTool("getAndroid")!.handler(args),
      );
    return { timer, manager, sessions, persistence, pool, internals, device, image, other, start };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function expectOrdinarySessionOnOther(f: Fixture, pending: Promise<unknown>) {
    const row = { ...(await f.persistence.getSession!(HOLDER))! };
    const outcome = await pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    // The different AVD is an ordinary acquisition (as it is when it boots on any other serial,
    // see "owner selector selecting a different running image mints an ordinary session").
    expect(outcome).toMatchObject({
      result: {
        structuredContent: {
          runtime: { deviceId: "emulator-5554", session: { sessionUuid: "fake-1" } },
        },
      },
    });
    expect(f.pool.getDevice("emulator-5554")).toMatchObject({
      name: "other-phone",
      sessionId: "fake-1",
    });
    // The hold on restart-phone and its row are untouched.
    expect(f.internals.rehydrationReservations.get(HOLDER)?.restartHandoff).toBe(true);
    expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  }

  test("control: a rival connection starts other-phone on the vacated serial", async () => {
    const f = await fixture();
    await expectOrdinarySessionOnOther(
      f,
      f.start({ avdName: f.other.name, __mcpSessionId: "rival-connection" }),
    );
  });

  test("the owner connection starts other-phone on the vacated serial", async () => {
    const f = await fixture();
    await expectOrdinarySessionOnOther(
      f,
      f.start({ avdName: f.other.name, __mcpSessionId: CONNECTION }),
    );
  });

  test("the owner's routing session starts other-phone on the vacated serial", async () => {
    const f = await fixture();
    await expectOrdinarySessionOnOther(f, f.start({ avdName: f.other.name }, HOLDER));
  });

  test("the owner resumes the reserved AVD on another serial after acquiring other-phone", async () => {
    const f = await fixture();
    await expectOrdinarySessionOnOther(
      f,
      f.start({ avdName: f.other.name, __mcpSessionId: CONNECTION }),
    );
    const moved = { ...f.device, deviceId: "emulator-5556" };
    f.manager.setDeviceImages("android", [{ ...f.image, deviceId: moved.deviceId }, f.other]);
    f.manager.setBootedDevices("android", [{ ...f.device, name: f.other.name }]);
    const result = await f.start({ avdName: moved.name, __mcpSessionId: CONNECTION });
    expect(result).toMatchObject({
      structuredContent: {
        runtime: { deviceId: moved.deviceId, session: { sessionUuid: HOLDER } },
      },
    });
    expect(f.manager.getCallCount("startDevice")).toBe(2);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  });

  test("a hold created during boot resumes by stable identity without admitted targets", async () => {
    const f = await fixture();
    f.manager.setBootedDevices("android", [f.device]);
    await f.pool.refreshDevices();
    expect(restartResumeSessionForDevice({ __mcpSessionId: CONNECTION }, f.device)).toBe(HOLDER);
  });

  test("a managed slot taking the device keeps priority over the fallback hold", async () => {
    let managed = false;
    const f = await fixture({
      refresh: async () => {},
      stableIdsFor: () => new Set(managed ? ["restart-phone"] : []),
      holderOf: () =>
        managed
          ? {
              platform: "android",
              stableDeviceId: "restart-phone",
              holder: "free",
              scopeKey: "managed-scope",
              slotIndex: null,
              scopeState: null,
              execSessionUuid: null,
            }
          : undefined,
    });
    f.manager.setBootedDevices("android", [f.device]);
    await f.pool.refreshDevices();
    managed = true;
    expect(restartResumeSessionForDevice({ __mcpSessionId: CONNECTION }, f.device)).toBeUndefined();
    expect(f.internals.rehydrationReservations.get(HOLDER)?.restartHandoff).toBe(true);
  });
});
