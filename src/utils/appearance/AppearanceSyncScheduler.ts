import type { AppearanceMode, BootedDevice } from "../../models";
import { DaemonState } from "../../daemon/daemonState";
import { DeviceSessionManager } from "../DeviceSessionManager";
import { applyAppearanceToDevice } from "../deviceAppearance";
import { logger } from "../logger";
import { getAppearanceConfig, resolveAppearanceMode } from "../../server/appearanceManager";
import { Timer, defaultTimer } from "../SystemTimer";

const DEFAULT_SYNC_INTERVAL_MS = 10000;

interface AppearanceSyncTarget extends BootedDevice {
  incarnation?: number;
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
}

export class AppearanceSyncScheduler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastAppliedModes = new Map<string, AppliedAppearance>();
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.pending;
    this.lastAppliedModes.clear();
  }

  async trigger(): Promise<void> {
    if (this.stopped) {
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
    const config = await this.dependencies.getConfig();
    if (this.stopped) {
      return;
    }
    if (!config.syncWithHost) {
      this.lastAppliedModes.clear();
      return;
    }

    const mode = await this.dependencies.resolveMode(config);
    if (this.stopped) {
      return;
    }
    const targets = this.dependencies.getTargets();
    if (targets.length === 0) {
      return;
    }

    for (const device of targets) {
      if (this.stopped) {
        return;
      }
      if (this.isAlreadyApplied(device, mode)) {
        continue;
      }
      try {
        await this.dependencies.apply(device, mode);
        if (!this.stopped) {
          this.lastAppliedModes.set(device.deviceId, {
            mode,
            incarnation: device.incarnation,
          });
        }
      } catch (error) {
        logger.warn(`[Appearance] Failed to apply host sync mode to ${device.deviceId}: ${error}`);
      }
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
        // Only return Android devices - appearance sync via ADB only works for Android
        return pooledDevices
          .filter((device) => device.platform === "android")
          .map((device) => ({
            deviceId: device.id,
            name: device.id,
            platform: device.platform,
            incarnation: device.incarnation,
          }));
      }
    }

    const current = DeviceSessionManager.getInstance().getCurrentDevice();
    // Only return if it's an Android device
    return current && current.platform === "android" ? [current] : [];
  }
}

const scheduler = new AppearanceSyncScheduler();

export function startAppearanceSyncScheduler(): void {
  scheduler.start();
}

export async function stopAppearanceSyncScheduler(): Promise<void> {
  await scheduler.stop();
}

export async function triggerAppearanceSync(): Promise<void> {
  await scheduler.trigger();
}
