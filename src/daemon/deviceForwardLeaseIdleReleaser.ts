import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { SingleFlightInterval } from "../utils/SingleFlightInterval";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { isDeviceLeaseBusy, type DeviceLeaseActivity } from "./deviceLeaseActivity";

/** What the idle releaser needs to know and do about each device lease. */
export interface DeviceForwardLeaseIdlePort {
  /** Devices whose CtrlProxy forwarding lease this process holds. */
  heldDeviceIds(): string[];
  /** Sessions, tool calls, CtrlProxy requests and streams using the device. */
  activity(deviceId: string): DeviceLeaseActivity;
  /** Give up the device's lease (close its CtrlProxy client and forward). */
  release(deviceId: string): Promise<void>;
}

const MAX_SWEEP_INTERVAL_MS = 15_000;

/**
 * Releases a device's CtrlProxy forwarding lease once this daemon has had no
 * live session, no stream subscriber, and no tool activity on it for `idleMs`
 * (issue #10497), so an unused daemon stops blocking every other AutoMobile
 * process from the device.
 * The next tool call re-acquires the lease on demand.
 */
export class DeviceForwardLeaseIdleReleaser {
  /** Last sweep at which each held device was busy (or first seen held). */
  private readonly lastBusyAt = new Map<string, number>();
  private readonly interval: SingleFlightInterval;

  constructor(
    private readonly port: DeviceForwardLeaseIdlePort,
    private readonly idleMs: number,
    private readonly timer: Timer = defaultTimer,
    sweepIntervalMs: number = Math.min(Math.max(1, Math.floor(idleMs / 4)), MAX_SWEEP_INTERVAL_MS),
  ) {
    this.interval = new SingleFlightInterval(timer, sweepIntervalMs, async () => {
      await this.sweep();
    });
  }

  start(): void {
    this.interval.start();
  }

  async stop(): Promise<void> {
    await this.interval.stop();
  }

  /** One pass; returns the devices whose lease was released. */
  async sweep(): Promise<string[]> {
    const now = this.timer.now();
    const held = new Set(this.port.heldDeviceIds());
    for (const deviceId of [...this.lastBusyAt.keys()]) {
      if (!held.has(deviceId)) {
        this.lastBusyAt.delete(deviceId);
      }
    }
    const idle = [...held].filter((deviceId) => this.isIdle(deviceId, now));
    const released: string[] = [];
    for (const deviceId of idle) {
      // Re-check right before releasing: a tool call may have bound meanwhile.
      if (!this.isIdle(deviceId, this.timer.now())) {
        continue;
      }
      try {
        logger.info(
          `[CTRL_PROXY] Releasing idle CtrlProxy forwarding lease for ${deviceId} ` +
            `(no session or tool activity for ${this.idleMs}ms)`,
        );
        this.lastBusyAt.delete(deviceId);
        await this.port.release(deviceId);
        released.push(deviceId);
      } catch (error) {
        logger.warn(
          `[CTRL_PROXY] Failed to release idle forwarding lease for ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return released;
  }

  private isIdle(deviceId: string, now: number): boolean {
    const activity = this.port.activity(deviceId);
    if (isDeviceLeaseBusy(activity)) {
      this.lastBusyAt.set(deviceId, now);
      return false;
    }
    const lastBusyAt = this.lastBusyAt.get(deviceId);
    if (lastBusyAt === undefined) {
      // First sight of this lease: start its idle clock now rather than release at once.
      this.lastBusyAt.set(deviceId, now);
      return false;
    }
    const idleForMs = activity.idleForMs ?? Number.POSITIVE_INFINITY;
    return Math.min(now - lastBusyAt, idleForMs) >= this.idleMs;
  }
}
