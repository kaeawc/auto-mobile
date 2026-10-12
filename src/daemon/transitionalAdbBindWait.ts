import type { DeviceAutolockChildProcess as ChildProcess } from "./devicePool";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { BackoffPolicy } from "../utils/Backoff";
import { TransitionalWaitBudget } from "../utils/TransitionalWaitBudget";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { DeviceTransportOfflineError } from "./deviceAcquisitionRefusals";
import { isTransitionalAdbState } from "./disconnectMonitor";

export const TRANSITIONAL_ADB_BIND_WAIT_BUDGET_MS = 5_000;

export function launchProcessLiveness(
  childProcess: ChildProcess | null | undefined,
): (() => boolean) | undefined {
  return childProcess
    ? () => childProcess.exitCode === null && childProcess.signalCode === null
    : undefined;
}

interface TransitionalAdbBindWaitPorts {
  timer: Timer;
  probe?: PlatformDeviceManager["getAndroidListedDeviceStates"];
  probeTimeoutMs: number;
  getSignal: () => AbortSignal | undefined;
  backoff?: BackoffPolicy;
  holdAbsenceAfterTransitional?: boolean;
  isLaunchProcessAlive?: () => boolean;
  /** This acquisition's boot just resolved an already-running Android runtime. */
  hasResolvedRuntime?: boolean;
}

/** One exact discovery's wait state; each delay requires an entirely fresh pool snapshot. */
export class TransitionalAdbBindWait {
  private observedTransitional = false;
  private readonly budget: TransitionalWaitBudget;

  constructor(
    private readonly deviceId: string,
    private readonly ports: TransitionalAdbBindWaitPorts,
  ) {
    this.budget = new TransitionalWaitBudget({
      ...ports,
      budgetMs: TRANSITIONAL_ADB_BIND_WAIT_BUDGET_MS,
    });
  }

  /** False preserves ordinary absence handling; true discards the caller's snapshot. */
  async waitIfTransitional(): Promise<boolean> {
    const { timer, probe, probeTimeoutMs, getSignal } = this.ports;
    const signal = getSignal();
    signal?.throwIfAborted();
    if (!probe) {
      return false;
    }
    const remaining = this.budget.remainingMs();
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
    if (state === undefined) {
      return this.waitForAbsentTransport();
    }
    if (!isTransitionalAdbState(state)) {
      // The transport returned after the caller captured an absent row. A boot-resolved
      // adopted runtime deserves the same fresh snapshot as this request's live launch.
      return this.waitForReturnedTransport();
    }
    this.observedTransitional = true;
    if (!(await this.budget.waitForNextAttempt())) {
      throw new DeviceTransportOfflineError(this.deviceId, state);
    }
    return true;
  }

  private async waitForReturnedTransport(): Promise<boolean> {
    return this.ports.hasResolvedRuntime
      ? this.waitForAbsentTransport()
      : this.ports.isLaunchProcessAlive?.()
        ? this.budget.waitForNextAttempt()
        : false;
  }

  private async waitForAbsentTransport(): Promise<boolean> {
    const launchAlive = this.ports.isLaunchProcessAlive?.() === true;
    if (launchAlive || this.ports.hasResolvedRuntime) {
      if (!(await this.budget.waitForNextAttempt())) {
        throw new DeviceTransportOfflineError(this.deviceId, undefined, !launchAlive);
      }
      return true;
    }
    // A transport may disappear briefly between offline and device during an adb reconnect.
    return this.ports.holdAbsenceAfterTransitional && this.observedTransitional
      ? await this.budget.waitForNextAttempt()
      : false;
  }
}
