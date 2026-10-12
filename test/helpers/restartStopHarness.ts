import { expect, spyOn } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager, type RehydrationDeviceReservation } from "../../src/daemon/sessionManager";
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
import { logger } from "../../src/utils/logger";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { warmedTests } from "./warmedTests";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "./devicePoolDependencies";

export const BASE = "restart-holder";
export const LABEL = `${BASE}:phone`;
export const SIBLING = `${BASE}:tablet`;
const originalLoggerWarn = logger.warn;
const originalIosManagerGetInstance = IOSCtrlProxyManager.getInstance;
const originalIosClientRetireInstance = IOSCtrlProxyClient.retireInstance;

interface RestartHoldInternals {
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    reason: SessionReleaseReason,
  ): Promise<void>;
  rehydrationReservations: Map<
    string,
    RehydrationDeviceReservation["target"] & {
      restartHandoff?: boolean;
      daemonRehydration?: boolean;
      scheduledDeadlineMs?: number;
      expiryTimer?: NodeJS.Timeout;
      ownerMcpSessionIds?: ReadonlySet<string>;
    }
  >;
  intentionalShutdowns: Map<string, number>;
  isReservedForShutdown(device: PooledDevice): boolean;
}

class StoppingDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];
  beforeKill: (() => void | Promise<void>) | undefined;
  stayRunning = false;

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    await this.beforeKill?.();
    if (!this.stayRunning) {
      this.setBootedDevices(device.platform, []);
    }
  }
}

export function restartStopHarness() {
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
    expect(logger.warn).toBe(originalLoggerWarn);
    expect(ToolRegistry.getAllTools()).toHaveLength(0);
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(getDbWriteBarrier().inFlightCount()).toBe(0);
    expect(getDbWriteBarrier().isDraining()).toBe(false);
    expect(IOSCtrlProxyManager.getInstance).toBe(originalIosManagerGetInstance);
    expect(IOSCtrlProxyClient.retireInstance).toBe(originalIosClientRetireInstance);
  });

  async function fixture(
    platform: Platform,
    labelHolder = false,
    publishLabels = false,
    connection: string | null = "owner-conn",
    handoff = true,
  ) {
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
    const persistence = new FakeDeviceSessionPersistence();
    const sessions = new SessionManager(
      timer,
      persistence,
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
    );
    sessions.attachDaemonSessionId("stop-hold-daemon");
    const journalFiles = new FakeTerminalReleaseJournalFileSystem();
    const journal = new FileTerminalReleaseJournal("stop-hold-journal", journalFiles);
    sessions.attachTerminalReleaseJournal(journal);
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
    if (labelHolder) {
      await sessions.createSession(BASE, "base-spare", platform);
      sessions.setDeviceLabels(BASE, { phone: LABEL, tablet: SIBLING });
    }
    const closeMint = labelHolder ? sessions.openPlanLabelMints(BASE, { phone: LABEL }) : () => {};
    await pool.bindOrReuseDeviceSession(
      holder,
      device.deviceId,
      platform,
      undefined,
      undefined,
      device,
      false,
      undefined,
      undefined,
      undefined,
      connection ?? undefined,
    );
    closeMint();
    if (publishLabels) {
      sessions.setDeviceLabels(BASE, { phone: LABEL, tablet: SIBLING });
    }
    const internals = pool as unknown as RestartHoldInternals;
    if (platform === "ios") {
      manager.beforeKill = () => expect(internals.intentionalShutdowns.size).toBe(0);
    }
    if (handoff) {
      await internals.releaseDisconnectedRecoverySessionWithRetry(
        holder,
        device.deviceId,
        `device-restart:${platform === "android" ? device.name : device.deviceId}`,
      );
      await pool.releaseDevice(device.deviceId, holder);
      expect(sessions.hasSession(holder)).toBe(false);
      expect(pool.genericAvailability(device.deviceId)).toBe("reserved");
    }
    registerDeviceTools();
    const call = (
      name: "killDevice" | "deleteDevice",
      requester?: string,
      force = false,
      mcpSessionId?: string,
      signal?: AbortSignal,
    ) =>
      runWithToolSelectionContext({ routingSessionUuid: requester }, () =>
        ToolRegistry.getTool(name)!.handler(
          name === "killDevice"
            ? { device, force, [INTERNAL_MCP_SESSION_PARAM]: mcpSessionId }
            : {
                target: {
                  platform,
                  isVirtual: true,
                  stableId: platform === "android" ? device.name : device.deviceId,
                },
                mode: "destroy",
                verifyAbsence: true,
                force,
                cancellationPolicy: "cancel-on-request-abort",
                [INTERNAL_MCP_SESSION_PARAM]: mcpSessionId,
              },
          undefined,
          signal,
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
    return {
      pool,
      sessions,
      persistence,
      timer,
      internals,
      device,
      holder,
      manager,
      kill,
      call,
      journal,
      journalFiles,
    };
  }

  return { test, fixture, cleanups };
}
