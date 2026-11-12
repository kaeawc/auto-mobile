import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

/** Matches the observation-stream accessibility screenshot reprobe interval. */
export const CTRLPROXY_CAPTURE_FAILURE_COOLDOWN_MS = 60_000;

/** Shared one-shot capture health, independent of any TakeScreenshot instance. */
export interface CtrlProxyCaptureCooldown {
  hasRecentFailure(deviceId: string): boolean;
  recordFailure(deviceId: string): void;
  clear(deviceId: string): void;
}

export class InMemoryCtrlProxyCaptureCooldown implements CtrlProxyCaptureCooldown {
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
    private readonly cooldownMs = CTRLPROXY_CAPTURE_FAILURE_COOLDOWN_MS,
  ) {}

  hasRecentFailure(deviceId: string): boolean {
    const failedAt = this.failedAt.get(deviceId);
    if (failedAt === undefined) {
      return false;
    }
    const elapsed = this.timer.now() - failedAt;
    // A negative elapsed time means the host clock moved backward: treat the cooldown as expired.
    if (elapsed >= 0 && elapsed < this.cooldownMs) {
      return true;
    }
    this.clear(deviceId);
    return false;
  }

  recordFailure(deviceId: string): void {
    // Opportunistically retire other expired devices without a background timer.
    for (const id of this.failedAt.keys()) {
      this.hasRecentFailure(id);
    }
    this.failedAt.set(deviceId, this.timer.now());
  }

  clear(deviceId: string): void {
    this.failedAt.delete(deviceId);
  }
}

export const defaultCtrlProxyCaptureCooldown: CtrlProxyCaptureCooldown =
  new InMemoryCtrlProxyCaptureCooldown();
