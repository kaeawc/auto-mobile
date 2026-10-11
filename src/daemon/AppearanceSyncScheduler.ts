import type { AppearanceConfig, AppearanceMode, BootedDevice } from "../models";
import { DaemonState } from "./daemonState";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import { applyAppearanceToDevice } from "../utils/deviceAppearance";
import { logger } from "../utils/logger";
import { getAppearanceConfig, resolveAppearanceMode } from "../server/appearanceManager";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { isAppearanceSyncEnabledFromEnvironment } from "../utils/appearance/appearanceSyncPolicy";

const DEFAULT_SYNC_INTERVAL_MS = 10000;
export const DEFAULT_APPEARANCE_APPLY_DEADLINE_MS = 10_000;

export interface AppearanceSyncTarget extends BootedDevice {
  incarnation?: number;
  /**
   * Base UUID of the session that holds the device. Its appearance config (#10976) decides whether
   * and how the device follows the host. A target without one uses the global config.
   */
  sessionKey?: string;
}

interface AppliedAppearance {
  mode: AppearanceMode;
  incarnation?: number;
}

export interface AppearanceSyncDependencies {
  getConfig: typeof getAppearanceConfig;
  resolveMode: typeof resolveAppearanceMode;
  /** Omitted: the scheduler's own targets, the pooled Android devices a session holds. */
  getTargets?: () => AppearanceSyncTarget[];
  apply: typeof applyAppearanceToDevice;
  isEnabled?: () => boolean;
  applyDeadlineMs?: number;
}

/**
 * What the process-wide scheduler reaches the config store, the host (`defaults`/`gsettings`
 * child processes) and the device (`adb`/`simctl`) through. One shared object, read at each use,
 * so a test that runs a real daemon can replace that boundary and restore it afterwards.
 */
export const defaultAppearanceSyncDependencies: AppearanceSyncDependencies = {
  getConfig: getAppearanceConfig,
  resolveMode: resolveAppearanceMode,
  apply: applyAppearanceToDevice,
  isEnabled: isAppearanceSyncEnabledFromEnvironment,
};

export interface AppearanceSyncScope {
  getTargets: () => AppearanceSyncTarget[];
  isEnabled?: () => boolean;
  /**
   * Runs before each apply, inside its tracked deadline: the daemon records the device's night-mode
   * default here so a sync-driven change is reset for the next owner (#11145). Must not reject.
   */
  beforeApply?: (device: AppearanceSyncTarget) => Promise<void>;
}

export class AppearanceSyncScheduler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastAppliedModes = new Map<string, AppliedAppearance>();
  private readonly inFlightApplies = new Map<string, Promise<boolean>>();
  private pending: Promise<void> | null = null;
  private readonly timer: Timer;
  private readonly dependencies: AppearanceSyncDependencies;
  private stopped = false;

  constructor(
    timer: Timer = defaultTimer,
    dependencies: AppearanceSyncDependencies = defaultAppearanceSyncDependencies,
  ) {
    this.timer = timer;
    this.dependencies = dependencies;
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.stopped = false;

    this.intervalHandle = this.timer.setInterval(() => {
      void this.trigger();
    }, DEFAULT_SYNC_INTERVAL_MS);

    void this.trigger();
  }

  setScope(scope: AppearanceSyncScope): void {
    this.scope = scope;
  }

  private scope: AppearanceSyncScope | undefined;

  private isEnabled(): boolean {
    return (
      (this.dependencies.isEnabled ?? isAppearanceSyncEnabledFromEnvironment)() &&
      (this.scope?.isEnabled?.() ?? true)
    );
  }

  async syncDevice(device: AppearanceSyncTarget): Promise<void> {
    if (this.stopped || !this.isEnabled() || device.platform !== "android") {
      return;
    }
    try {
      const config = await this.dependencies.getConfig(device.sessionKey);
      if (!config.syncWithHost || this.stopped) {
        return;
      }
      const mode = await this.dependencies.resolveMode(config);
      if (!this.stopped) {
        await this.applyToDevice(device, mode, config);
      }
    } catch (error) {
      logger.warn(`[Appearance] Failed to apply host sync mode to ${device.deviceId}: ${error}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.pending;
    this.lastAppliedModes.clear();
    // Uncancellable applies stay tracked until settlement, including across restarts.
  }

  async trigger(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (!this.isEnabled()) {
      return;
    }
    if (this.pending) {
      return this.pending;
    }

    // Best-effort background sync: swallow all errors here so a failed appearance
    // read (a transient DB error, or a missing/malformed appearance_configs row)
    // never floats an unhandledRejection from the fire-and-forget callers
    // (`void this.trigger()` in the interval and Daemon.start()). A host-
    // appearance-sync hiccup must not crash an otherwise-healthy daemon into a
    // restart loop (issue #2784).
    this.pending = this.tick()
      .catch((error) => {
        logger.warn(`[Appearance] Host sync tick failed: ${error}`);
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  private async tick(): Promise<void> {
    const targets = this.scope?.getTargets() ?? this.ownTargets();
    if (this.stopped) {
      return;
    }
    // Each device follows the config of the session that holds it (#10976), so one session's
    // choice never re-themes a device another session holds.
    const modes = new Map<string, Promise<AppearanceMode>>();
    for (const device of targets) {
      if (this.stopped) {
        return;
      }
      try {
        const config = await this.dependencies.getConfig(device.sessionKey);
        if (this.stopped) {
          return;
        }
        if (!config.syncWithHost) {
          this.lastAppliedModes.delete(device.deviceId);
          continue;
        }
        const modeKey = `${config.syncWithHost}:${config.defaultMode}`;
        let resolved = modes.get(modeKey);
        if (!resolved) {
          resolved = this.dependencies.resolveMode(config);
          modes.set(modeKey, resolved);
        }
        const mode = await resolved;
        if (this.stopped) {
          return;
        }
        if (this.isAlreadyApplied(device, mode)) {
          continue;
        }
        await this.applyToDevice(device, mode, config);
      } catch (error) {
        logger.warn(`[Appearance] Failed to apply host sync mode to ${device.deviceId}: ${error}`);
      }
    }
  }

  /**
   * Apply `mode` to `device` for the holder and config the caller decided under. The decision can
   * be seconds old by the time the write is due: a tick waits up to the apply deadline on each
   * earlier device, and `beforeApply` waits behind the device's pending reset. So the write is
   * issued only if {@link applyIfStillOwed} finds the decision still stands at that moment (#11641).
   */
  private async applyToDevice(
    device: AppearanceSyncTarget,
    mode: AppearanceMode,
    config: AppearanceConfig,
  ): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (this.inFlightApplies.has(device.deviceId)) {
      // A timed-out apply cannot be cancelled; a later tick can retry after it settles.
      logger.debug(`[Appearance] Skipping ${device.deviceId}: appearance apply still in flight`);
      return;
    }

    let timedOut = false;
    const apply = this.applyIfStillOwed(device, mode, config);
    this.inFlightApplies.set(device.deviceId, apply);
    void apply.then(
      () => {
        this.inFlightApplies.delete(device.deviceId);
      },
      (error: unknown) => {
        this.inFlightApplies.delete(device.deviceId);
        if (timedOut) {
          logger.warn(`[Appearance] Apply failed after deadline for ${device.deviceId}`, error);
        }
      },
    );
    const written = await raceWithDeadline(apply, {
      timer: this.timer,
      timeoutMs: this.dependencies.applyDeadlineMs ?? DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
      label: `Appearance apply for ${device.deviceId}`,
      onTimeout: () => {
        timedOut = true;
      },
    });
    if (written && !this.stopped) {
      this.lastAppliedModes.set(device.deviceId, { mode, incarnation: device.incarnation });
    }
  }

  /**
   * Resolves true when the device was written, false when the write was no longer owed: the
   * scheduler stopped, sync was switched off, the session the decision was made for no longer
   * holds the device, or that session's config no longer asks for the same thing.
   *
   * The config re-read is the last await. The stopped flag, the kill switch and the holder are
   * read after it and the write is issued in that same turn, with no awaited helper in between,
   * so nothing can change between the last check and the write.
   */
  private async applyIfStillOwed(
    device: AppearanceSyncTarget,
    mode: AppearanceMode,
    decidedUnder: AppearanceConfig,
  ): Promise<boolean> {
    // beforeApply records the device's defaults for its holder: not for a device that has none.
    if (this.scope?.beforeApply && !this.skipReason(device)) {
      await this.scope.beforeApply(device);
    }
    let reason = this.skipReason(device);
    if (!reason) {
      const config = await this.dependencies.getConfig(device.sessionKey);
      reason =
        this.skipReason(device) ??
        (config.syncWithHost && config.defaultMode === decidedUnder.defaultMode
          ? undefined
          : "its holder's appearance config changed");
    }
    if (reason) {
      logger.debug(`[Appearance] Skipping ${device.deviceId}: ${reason} before the apply`);
      return false;
    }
    await this.dependencies.apply(device, mode);
    return true;
  }

  /** Why a decided write must not happen now, read synchronously; undefined when it may. */
  private skipReason(device: AppearanceSyncTarget): string | undefined {
    if (this.stopped) {
      return "the scheduler stopped";
    }
    if (!this.isEnabled()) {
      return "appearance sync was switched off";
    }
    return this.isHeldBySameSession(device) ? undefined : "its holder changed";
  }

  /** The scope's current view: the same session (or the same absence of one) holds the device. */
  private isHeldBySameSession(device: AppearanceSyncTarget): boolean {
    const current = (this.scope?.getTargets() ?? this.ownTargets()).find(
      (target) => target.deviceId === device.deviceId,
    );
    return current !== undefined && current.sessionKey === device.sessionKey;
  }

  private isAlreadyApplied(device: AppearanceSyncTarget, mode: AppearanceMode): boolean {
    const previous = this.lastAppliedModes.get(device.deviceId);
    return (
      previous?.mode === mode &&
      (previous.incarnation === undefined ||
        device.incarnation === undefined ||
        previous.incarnation === device.incarnation)
    );
  }

  /** The targets of a scheduler nothing has scoped: the injected ones, else the pool's. */
  private ownTargets(): AppearanceSyncTarget[] {
    return this.dependencies.getTargets?.() ?? this.getSyncTargets();
  }

  private getSyncTargets(): AppearanceSyncTarget[] {
    const daemonState = DaemonState.getInstance();
    if (daemonState.isInitialized()) {
      const pool = daemonState.getDevicePool();
      const pooledDevices = pool.getAllDevices();
      if (pooledDevices.length > 0) {
        const sessions = daemonState.getSessionManager().getAllSessions();
        return pooledDevices.flatMap((device) => {
          const holder = sessions.find((session) => session.assignedDevice === device.id);
          return device.platform === "android" && holder
            ? [
                {
                  deviceId: device.id,
                  name: device.id,
                  platform: device.platform,
                  incarnation: device.incarnation,
                  sessionKey: holder.sessionId,
                },
              ]
            : [];
        });
      }
    }

    const current = DeviceSessionManager.getInstance().getCurrentDevice();
    // Only return if it's an Android device
    return current && current.platform === "android" ? [current] : [];
  }
}

const scheduler = new AppearanceSyncScheduler();

export function startAppearanceSyncScheduler(scope?: AppearanceSyncScope): void {
  if (scope) {
    scheduler.setScope(scope);
  }
  scheduler.start();
}

export async function stopAppearanceSyncScheduler(): Promise<void> {
  await scheduler.stop();
}

export async function triggerAppearanceSync(): Promise<void> {
  await scheduler.trigger();
}

export async function syncAppearanceForDevice(device: AppearanceSyncTarget): Promise<void> {
  await scheduler.syncDevice(device);
}
