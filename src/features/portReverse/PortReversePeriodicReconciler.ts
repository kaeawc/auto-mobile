import { runOutsideRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { PortReverseManager, PortReverseRestoreFailure } from "./PortReverseManager";

/** Default wait between periodic reconcile passes. */
export const PORT_REVERSE_RECONCILE_INTERVAL_MS = 30_000;
/** Devices one pass reconciles at most; the rest are taken, in rotation, by the next passes. */
export const PORT_REVERSE_RECONCILE_MAX_DEVICES_PER_PASS = 4;

/** One device's outcome in a pass. `error`: the reconcile could not run (device unreachable). */
export interface PortReverseReconcileDeviceResult {
  deviceId: string;
  restored: number[];
  restoreFailures: PortReverseRestoreFailure[];
  error?: string;
}

/** What one pass did, for logs and tests. */
export interface PortReverseReconcilePass {
  devices: PortReverseReconcileDeviceResult[];
}

export interface PortReversePeriodicReconcilerDeps {
  manager: Pick<PortReverseManager, "reconcile" | "ownedDevices">;
  timer: Timer;
  intervalMs?: number;
  maxDevicesPerPass?: number;
  onPass?: (pass: PortReverseReconcilePass) => void;
}

/**
 * Periodically re-applies owned `adb reverse` mappings that disappeared without a transport event
 * (#17254): a raw `adb reverse --remove`, or another tool, removes one while the session and device
 * stay up, and nothing else would notice until the session's next `portReverse` call. The timer is
 * armed only while some device holds owned mappings ({@link wake} on each ensure) and stops once
 * none does. A pass reconciles at most `maxDevicesPerPass` devices, one at a time, rotating so every
 * device is reached. A device that cannot be reached is logged and retried on a later pass; its
 * mappings stay owned. Foreign mappings are never touched (the manager's contract).
 */
export class PortReversePeriodicReconciler {
  private readonly intervalMs: number;
  private readonly maxDevicesPerPass: number;
  private timeout: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** The last device a pass reached, so the next pass starts after it. */
  private lastDevice: string | undefined;
  private disposed = false;

  constructor(private readonly deps: PortReversePeriodicReconcilerDeps) {
    this.intervalMs = Math.max(1, deps.intervalMs ?? PORT_REVERSE_RECONCILE_INTERVAL_MS);
    this.maxDevicesPerPass = Math.max(
      1,
      deps.maxDevicesPerPass ?? PORT_REVERSE_RECONCILE_MAX_DEVICES_PER_PASS,
    );
  }

  /** Some device now holds owned mappings: arm the timer unless a pass is already pending or running. */
  wake(): void {
    if (this.disposed || this.timeout !== null || this.running !== null) {
      return;
    }
    this.arm();
  }

  /** Whether a pass is scheduled. */
  isArmed(): boolean {
    return this.timeout !== null;
  }

  /** Cancels the pending pass and waits for a running one to finish; nothing runs afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timeout !== null) {
      this.deps.timer.clearTimeout(this.timeout);
      this.timeout = null;
    }
    await this.running;
  }

  /**
   * Arms the next pass outside any request's AbortContext: the waking ensure runs inside a tool
   * call, and this daemon-owned work must not inherit (and be aborted by) its cancellation.
   */
  private arm(): void {
    if (this.deps.manager.ownedDevices().length === 0) {
      return;
    }
    const handle = runOutsideRequestContext(() =>
      this.deps.timer.setTimeout(() => {
        this.timeout = null;
        this.running = runOutsideRequestContext(() => this.pass()).finally(() => {
          this.running = null;
          if (!this.disposed) {
            this.arm();
          }
        });
      }, this.intervalMs),
    );
    // Best-effort background work never holds the process open during shutdown.
    handle.unref?.();
    this.timeout = handle;
  }

  /** Up to `maxDevicesPerPass` owned devices, starting after the one the last pass ended on. */
  private nextDevices(): string[] {
    const owned = this.deps.manager.ownedDevices();
    const last = this.lastDevice;
    const start = last === undefined ? 0 : owned.findIndex((deviceId) => deviceId > last);
    const rotated = start <= 0 ? owned : [...owned.slice(start), ...owned.slice(0, start)];
    return rotated.slice(0, this.maxDevicesPerPass);
  }

  private async pass(): Promise<void> {
    const devices: PortReverseReconcileDeviceResult[] = [];
    for (const deviceId of this.nextDevices()) {
      if (this.disposed) {
        break;
      }
      this.lastDevice = deviceId;
      devices.push(await this.reconcileOne(deviceId));
    }
    if (devices.length > 0) {
      this.deps.onPass?.({ devices });
    }
  }

  private async reconcileOne(deviceId: string): Promise<PortReverseReconcileDeviceResult> {
    try {
      const report = await this.deps.manager.reconcile(deviceId);
      if (report.restored.length > 0) {
        logger.info(
          `[portReverse] periodic reconcile restored ${report.restored.map((p) => `tcp:${p}`).join(", ")} on ${deviceId}`,
        );
      }
      return { deviceId, ...report };
    } catch (error) {
      // Expected while a device is offline or reconnecting: its mappings stay owned, the next pass
      // (or the transport-recovery path) retries, and the session's next call reports any failure.
      logger.debug(
        `[portReverse] periodic reconcile of ${deviceId} failed: ${errorMessage(error)}`,
      );
      return { deviceId, restored: [], restoreFailures: [], error: errorMessage(error) };
    }
  }
}
