import { Daemon } from "../../../src/daemon/daemon";
import { DeviceLossState } from "../../../src/daemon/deviceLossState";
import type { PooledDevice } from "../../../src/daemon/devicePool";
import type { SingleFlightInterval } from "../../../src/daemon/SingleFlightInterval";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeDatabaseInitializer } from "../../fakes/FakeDatabaseInitializer";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../../fakes/FakeStartupFailureTracker";
import type { FakeTimer } from "../../fakes/FakeTimer";

/** A pooled-device record a test can mutate, as the pool does while a device is reassigned. */
export type MutablePooledDevice = { -readonly [K in keyof PooledDevice]: PooledDevice[K] };

export function createPooledDevice(
  id: string,
  overrides: Partial<MutablePooledDevice> = {},
): MutablePooledDevice {
  return {
    id,
    name: "Pixel",
    platform: "android",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
    incarnation: 1,
    ...overrides,
  };
}

/** Test replacements for the daemon steps a disconnect tick hands off to other subsystems. */
export interface DaemonDisconnectHooks {
  shouldSkipStaleDisconnectCleanup?: () => Promise<boolean>;
  recordAndTryRecoverCapturedDisconnect?: () => Promise<{
    incidentId: string | undefined;
    handled: boolean;
  }>;
  cancelAndReleaseSession?: (sessionId: string) => Promise<boolean>;
  stopRecordingAfterDeviceDisconnect?: () => Promise<boolean>;
}

/**
 * A real `Daemon`, built over fake dependencies, whose device-disconnect state and steps are
 * reachable through named test seams instead of casts to its private shape. The pool and session
 * manager are the daemon's own (`getDevicePool()` / `getSessionManager()`); tests replace the
 * methods they drive on them.
 */
export class DaemonDisconnectHarness extends Daemon {
  constructor(
    timer: FakeTimer,
    private readonly hooks: DaemonDisconnectHooks = {},
  ) {
    super(
      {},
      {
        installedAppsRepository: new FakeInstalledAppsRepository(),
        timer,
        idGenerator: new CountingIdGenerator("daemon-session"),
        databaseInitializer: new FakeDatabaseInitializer(),
        startupFailureTracker: new FakeStartupFailureTracker(),
        databaseHealthProbe: { check: async () => {} },
        recoverFromDatabaseHealthFailure: () => {},
      },
    );
  }

  protected async shouldSkipStaleDisconnectCleanup(
    ...args: Parameters<Daemon["shouldSkipStaleDisconnectCleanup"]>
  ): Promise<boolean> {
    return this.hooks.shouldSkipStaleDisconnectCleanup
      ? this.hooks.shouldSkipStaleDisconnectCleanup()
      : super.shouldSkipStaleDisconnectCleanup(...args);
  }

  protected async recordAndTryRecoverCapturedDisconnect(
    ...args: Parameters<Daemon["recordAndTryRecoverCapturedDisconnect"]>
  ): ReturnType<Daemon["recordAndTryRecoverCapturedDisconnect"]> {
    return this.hooks.recordAndTryRecoverCapturedDisconnect
      ? this.hooks.recordAndTryRecoverCapturedDisconnect()
      : super.recordAndTryRecoverCapturedDisconnect(...args);
  }

  async cancelAndReleaseSession(
    ...args: Parameters<Daemon["cancelAndReleaseSession"]>
  ): Promise<boolean> {
    return this.hooks.cancelAndReleaseSession
      ? this.hooks.cancelAndReleaseSession(args[0])
      : super.cancelAndReleaseSession(...args);
  }

  protected stopRecordingAfterDeviceDisconnect(
    ...args: Parameters<Daemon["stopRecordingAfterDeviceDisconnect"]>
  ): Promise<boolean> {
    return this.hooks.stopRecordingAfterDeviceDisconnect
      ? this.hooks.stopRecordingAfterDeviceDisconnect()
      : super.stopRecordingAfterDeviceDisconnect(...args);
  }

  /** Start the real disconnect monitor over the given device manager and recordings reader. */
  startMonitor(...args: Parameters<Daemon["startDeviceDisconnectMonitor"]>): void {
    this.startDeviceDisconnectMonitor(...args);
  }

  /** Subscribe the real ADB-missing-device listener. */
  startMissingDeviceListener(): void {
    this.startAdbMissingDeviceListener();
  }

  stopMissingDeviceListener(): void {
    this.runtime.unsubscribeAdbMissingDevice?.();
  }

  shouldSkipStaleCleanup(
    ...args: Parameters<Daemon["shouldSkipStaleDisconnectCleanup"]>
  ): Promise<boolean> {
    return super.shouldSkipStaleDisconnectCleanup(...args);
  }

  isCapturedTargetCurrent(
    ...args: Parameters<Daemon["isCapturedDisconnectTargetCurrent"]>
  ): boolean {
    return this.isCapturedDisconnectTargetCurrent(...args);
  }

  get disconnectMonitor(): SingleFlightInterval | null {
    return this.runtime.deviceDisconnectMonitor;
  }

  get disconnectMisses(): Map<string, number> {
    return this.deviceLoss.misses;
  }

  get missIncarnations(): DeviceLossState["missIncarnations"] {
    return this.deviceLoss.missIncarnations;
  }

  get confirmedDisconnected(): Set<string> {
    return this.deviceLoss.confirmedDisconnectedIds;
  }

  get forcedDisconnected(): Set<string> {
    return this.deviceLoss.forceDisconnectedIds;
  }

  set forcedDisconnected(ids: Set<string>) {
    Object.assign(this, {
      deviceLoss: new DeviceLossState({ ...this.deviceLoss, forceDisconnectedIds: ids }),
    });
  }

  get forceGenerations(): Map<string, number> {
    return this.deviceLoss.forceDisconnectedGenerations;
  }

  get offlineRecoveryAttempted(): Set<string> {
    return this.deviceLoss.offlineRecoveryAttemptedIds;
  }

  get offlineRecoveryIncarnations(): Map<string, number | string> {
    return this.deviceLoss.offlineRecoveryAttemptedIncarnations;
  }
}
