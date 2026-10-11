import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { DeviceTransportOfflineError } from "./deviceAcquisitionRefusals";
import { isTransitionalAdbState } from "./disconnectMonitor";

export const TRANSITIONAL_ADB_BIND_WAIT_BUDGET_MS = 5_000;

interface TransitionalAdbBindWaitPorts {
  timer: Timer;
  probe?: PlatformDeviceManager["getAndroidListedDeviceStates"];
  probeTimeoutMs: number;
  getSignal: () => AbortSignal | undefined;
  backoff?: BackoffPolicy;
}

/** One exact discovery's wait state; each delay requires an entirely fresh pool snapshot. */
export class TransitionalAdbBindWait {
  private firstProbeMs: number | undefined;
  private attempt = 0;
  private readonly backoff: BackoffPolicy;

  constructor(
    private readonly deviceId: string,
    private readonly ports: TransitionalAdbBindWaitPorts,
  ) {
    this.backoff = ports.backoff ?? exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 1_000 });
  }

  /** False preserves ordinary absence handling; true discards the caller's snapshot. */
  async waitIfTransitional(): Promise<boolean> {
    const { timer, probe, probeTimeoutMs, getSignal } = this.ports;
    const signal = getSignal();
    signal?.throwIfAborted();
    if (!probe) {
      return false;
    }
    this.firstProbeMs ??= timer.now();
    const remaining = this.remainingMs();
    let state: string | undefined;
    try {
      // Exhaustion still needs current evidence, with a short positive probe cap.
      const timeoutMs = Math.min(probeTimeoutMs, remaining > 0 ? remaining : 100);
      const states = await raceWithDeadline(() => probe([this.deviceId], { signal, timeoutMs }), {
        timer,
        signal,
        timeoutMs,
        label: "Exact device adb liveness probe",
      });
      state = states.get(this.deviceId);
    } catch (error) {
      signal?.throwIfAborted();
      // A failed best-effort probe leaves the existing absence decision in charge.
      logger.warn("Exact device adb liveness probe failed", error);
      return false;
    }
    signal?.throwIfAborted();
    if (state === undefined || !isTransitionalAdbState(state)) {
      return false;
    }
    const delayMs = Math.min(this.backoff.delayForAttempt(++this.attempt), this.remainingMs());
    if (delayMs <= 0) {
      throw new DeviceTransportOfflineError(this.deviceId, state);
    }
    await this.wait(delayMs, signal);
    signal?.throwIfAborted();
    return true;
  }

  private async wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    const { timer } = this.ports;
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = timer.setTimeout(resolve, delayMs);
          }),
        { timer, signal, label: "Exact device adb transport wait" },
      );
    } finally {
      if (handle !== undefined) {
        timer.clearTimeout(handle);
      }
    }
  }

  private remainingMs(): number {
    return this.firstProbeMs === undefined
      ? TRANSITIONAL_ADB_BIND_WAIT_BUDGET_MS
      : TRANSITIONAL_ADB_BIND_WAIT_BUDGET_MS - (this.ports.timer.now() - this.firstProbeMs);
  }
}
