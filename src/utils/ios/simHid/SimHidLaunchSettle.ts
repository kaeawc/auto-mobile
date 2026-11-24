import { defaultTimer, type Timer } from "../../SystemTimer";

/**
 * HID input skips XCTest's idle synchronization, so a touch sent while an app is still launching
 * can be lost (#19019: a tap ~2 s after `simctl launch` was dropped, the retry landed). Touches
 * on the HID path wait until this long after the last launch on that simulator.
 */
export const SIM_HID_LAUNCH_SETTLE_MS = 3_000;

export class SimHidLaunchSettle {
  private readonly launches = new Map<string, number>();

  constructor(
    private readonly timer: Pick<Timer, "now" | "sleep"> = defaultTimer,
    private readonly settleMs: number = SIM_HID_LAUNCH_SETTLE_MS,
  ) {}

  noteLaunch(deviceId: string): void {
    this.launches.set(deviceId, this.timer.now());
  }

  remainingMs(deviceId: string): number {
    const launchedAt = this.launches.get(deviceId);
    if (launchedAt === undefined) {
      return 0;
    }
    const remaining = launchedAt + this.settleMs - this.timer.now();
    if (remaining <= 0) {
      this.launches.delete(deviceId);
      return 0;
    }
    return remaining;
  }

  async wait(deviceId: string): Promise<void> {
    const remaining = this.remainingMs(deviceId);
    if (remaining > 0) {
      await this.timer.sleep(remaining);
    }
  }
}

export const simHidLaunchSettle = new SimHidLaunchSettle();
