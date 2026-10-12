import { describe, expect, spyOn } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager } from "../../src/daemon/sessionManager";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, Platform } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { warmedTests } from "../helpers/warmedTests";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const BASE = "restart-holder";
const LABEL = `${BASE}:phone`;
const SIBLING = `${BASE}:tablet`;
const originalIosManagerGetInstance = IOSCtrlProxyManager.getInstance;
const originalIosClientRetireInstance = IOSCtrlProxyClient.retireInstance;

interface RestartHoldInternals {
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    reason: SessionReleaseReason,
  ): Promise<void>;
  rehydrationReservations: Map<string, { restartHandoff?: boolean; daemonRehydration?: boolean }>;
  intentionalShutdowns: Map<string, number>;
}

class StoppingDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];
  beforeKill: (() => void) | undefined;

  override async killDevice(device: BootedDevice): Promise<void> {
    this.beforeKill?.();
    this.killed.push(device.deviceId);
    this.setBootedDevices(device.platform, []);
  }
}

describe("lifecycle stops drop only the requester's device-restart hold", () => {
  const cleanups: Array<() => void> = [];

  const test = warmedTests(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    resetDbWriteBarrier();
    expect(ToolRegistry.getAllTools()).toHaveLength(0);
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(getDbWriteBarrier().inFlightCount()).toBe(0);
    expect(getDbWriteBarrier().isDraining()).toBe(false);
    expect(IOSCtrlProxyManager.getInstance).toBe(originalIosManagerGetInstance);
    expect(IOSCtrlProxyClient.retireInstance).toBe(originalIosClientRetireInstance);
  });

  async function fixture(platform: Platform, labelHolder = false, publishLabels = false) {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const manager = new StoppingDeviceManager();
    const device: BootedDevice = {
      platform,
      name: "restart-phone",
      deviceId: platform === "android" ? "emulator-5554" : "restart-sim",
    };
    manager.setBootedDevices(platform, [device]);
    manager.setDeviceImages(platform, [device]);
    const sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
    );
    sessions.attachDaemonSessionId("stop-hold-daemon");
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "stop-hold-daemon", {
        timer,
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      }),
    );
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
    const iosStop = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      stop: async () => {},
    } as unknown as IOSCtrlProxyManager);
    const iosRetire = spyOn(IOSCtrlProxyClient, "retireInstance").mockResolvedValue(undefined);
    cleanups.push(() => {
      iosStop.mockRestore();
      iosRetire.mockRestore();
    });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => new FakeAvdManager(),
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
      ensureCtrlProxyReady: async () => {},
      stopPerformanceMonitoring: () => {},
      stopAndroidObservers: async () => {},
      resolveRunningAndroidAvdName: async () => device.name,
      timer,
    });
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessions, pool);
    const holder = labelHolder ? LABEL : BASE;
    await pool.bindOrReuseDeviceSession(
      holder,
      device.deviceId,
      platform,
      undefined,
      undefined,
      device,
    );
    if (labelHolder) {
      await sessions.createSession(BASE, "base-spare", platform);
    }
    if (publishLabels || labelHolder) {
      sessions.setDeviceLabels(BASE, { phone: LABEL, tablet: SIBLING });
    }
    const internals = pool as unknown as RestartHoldInternals;
    if (platform === "ios") {
      manager.beforeKill = () => expect(internals.intentionalShutdowns.size).toBe(0);
    }
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      holder,
      device.deviceId,
      `device-restart:${platform === "android" ? device.name : device.deviceId}`,
    );
    await pool.releaseDevice(device.deviceId, holder);
    expect(sessions.hasSession(holder)).toBe(false);
    expect(pool.genericAvailability(device.deviceId)).toBe("reserved");
    registerDeviceTools();
    const call = (name: "killDevice" | "deleteDevice", requester?: string, force = false) =>
      runWithToolSelectionContext({ routingSessionUuid: requester }, () =>
        ToolRegistry.getTool(name)!.handler(
          name === "killDevice"
            ? { device, force }
            : {
                target: {
                  platform,
                  isVirtual: true,
                  stableId: platform === "android" ? device.name : device.deviceId,
                },
                mode: "destroy",
                verifyAbsence: true,
                force,
              },
        ),
      );
    async function kill(requester?: string, force = false) {
      await call("killDevice", requester, force);
      expect(manager.killed).toEqual([device.deviceId]);
      if (platform === "ios") {
        expect(internals.intentionalShutdowns.size).toBe(0);
      }
      await pool.initializeWithDevices([device]);
    }
    return { pool, sessions, internals, device, holder, manager, kill, call };
  }

  for (const platform of ["android", "ios"] as const) {
    test(`${platform}: reserving session's killDevice drops its hold`, async () => {
      const f = await fixture(platform);
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
    });
    for (const requester of [BASE, SIBLING]) {
      test(`${platform}: live base resolves label holder for requester ${requester}`, async () => {
        const f = await fixture(platform, true);
        expect(f.sessions.getDeviceLabels(BASE)).toEqual({ phone: LABEL, tablet: SIBLING });
        await f.kill(requester);
        expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
        expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
      });
    }
    test(`${platform}: handed-off base cannot resolve its label requester`, async () => {
      const f = await fixture(platform, false, true);
      expect(f.sessions.getDeviceLabels(BASE)).toBeUndefined();
      await f.kill(LABEL);
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    for (const force of [false, true]) {
      test(`${platform}: another session's killDevice preserves the hold, force ${force}`, async () => {
        const f = await fixture(platform);
        await f.kill("other-session", force);
        expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
        expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      });
    }
    test(`${platform}: sessionless killDevice preserves the hold`, async () => {
      const f = await fixture(platform);
      await f.kill();
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    test(`${platform}: holder stop preserves the daemon-restart source`, async () => {
      const f = await fixture(platform);
      await f.pool.reserveDevicesForRehydration([
        {
          sessionId: BASE,
          target: {
            platform,
            stableDeviceId: platform === "android" ? f.device.name : f.device.deviceId,
            deviceId: f.device.deviceId,
          },
        },
      ]);
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.get(BASE)).toMatchObject({
        restartHandoff: false,
        daemonRehydration: true,
      });
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      f.pool.releaseRehydrationReservation(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: reserving session's deleteDevice drops its hold`, async () => {
      const f = await fixture(platform);
      const response = await f.call("deleteDevice", BASE);
      expect(response).toMatchObject({
        structuredContent: { state: "destroyed", command: { stop: "accepted" } },
      });
      expect(f.manager.killed).toEqual([f.device.deviceId]);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      if (platform === "ios") {
        expect(f.internals.intentionalShutdowns.size).toBe(0);
      }
    });
  }
});
