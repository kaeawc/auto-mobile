import type { AppearanceMode, BootedDevice } from "../models";
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

interface AppearanceSyncDependencies {
  getConfig: typeof getAppearanceConfig;
  resolveMode: typeof resolveAppearanceMode;
  getTargets: () => AppearanceSyncTarget[];
  apply: typeof applyAppearanceToDevice;
  isEnabled?: () => boolean;
  applyDeadlineMs?: number;
}

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
  private readonly inFlightApplies = new Map<string, Promise<void>>();
  private pending: Promise<void> | null = null;
  private readonly timer: Timer;
  private readonly dependencies: AppearanceSyncDependencies;
  private stopped = false;

  constructor(
    timer: Timer = defaultTimer,
    dependencies: AppearanceSyncDependencies = {
      getConfig: getAppearanceConfig,
      resolveMode: resolveAppearanceMode,
      getTargets: () => this.getSyncTargets(),
      apply: applyAppearanceToDevice,
      isEnabled: isAppearanceSyncEnabledFromEnvironment,
    },
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
        await this.applyToDevice(device, mode);
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
    const targets = this.scope?.getTargets() ?? this.dependencies.getTargets();
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
        await this.applyToDevice(device, mode);
      } catch (error) {
        logger.warn(`[Appearance] Failed to apply host sync mode to ${device.deviceId}: ${error}`);
      }
    }
  }

  private async applyToDevice(device: AppearanceSyncTarget, mode: AppearanceMode): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (this.inFlightApplies.has(device.deviceId)) {
      // A timed-out apply cannot be cancelled; a later tick can retry after it settles.
      logger.debug(`[Appearance] Skipping ${device.deviceId}: appearance apply still in flight`);
      return;
    }

    let timedOut = false;
    const beforeApply = this.scope?.beforeApply;
    const apply = beforeApply
      ? beforeApply(device).then(() => this.dependencies.apply(device, mode))
      : this.dependencies.apply(device, mode);
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
    await raceWithDeadline(apply, {
      timer: this.timer,
      timeoutMs: this.dependencies.applyDeadlineMs ?? DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
      label: `Appearance apply for ${device.deviceId}`,
      onTimeout: () => {
        timedOut = true;
      },
    });
    if (!this.stopped) {
      this.lastAppliedModes.set(device.deviceId, { mode, incarnation: device.incarnation });
    }
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
