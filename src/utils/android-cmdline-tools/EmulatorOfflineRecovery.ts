import type { AdbClientFactory } from "./AdbClientFactory";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";
import type { AndroidEmulatorReadinessOptions } from "./AndroidEmulatorClient";
import { AndroidOfflineProbeError } from "./AndroidOfflineProbeError";
import { throwIfReadinessAborted } from "./emulatorReadinessEvaluation";
import { MIN_EMULATOR_POLLING_INTERVAL_MS, type OfflineTracker } from "./EmulatorReadinessPoller";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { Timer } from "../SystemTimer";

// A freshly-provisioned AVD's first cold boot can land its serial in ADB
// `offline` and stay there. This bounds a single re-detect recovery while
// normal readiness polling continues through the caller's full budget.
const FRESH_OFFLINE_RECOVERY_THRESHOLD_MS = 15_000;
const FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS = 5_000;
// Continue checking at a bounded cadence after recovery so a device that
// becomes ready before the deadline is observed despite a large configured interval.
const FRESH_OFFLINE_POST_RECOVERY_POLL_INTERVAL_MS = 5_000;

/** Probe and recovery options shared by the offline-state entry points. */
export interface OfflineProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The readiness wait a fresh-offline recovery runs inside. */
export interface FreshOfflineRecoveryContext {
  avdName: string;
  signal: AbortSignal | undefined;
  /** When the readiness wait started, on the host timer. */
  startTime: number;
  /** The readiness wait's whole budget, measured from {@link startTime}. */
  timeoutMs: number;
}

/** The current time, the configured polling cadence and what is left of the readiness budget. */
export interface PollingDelayBudget {
  now: number;
  pollingIntervalMs: number;
  remainingPollingTimeMs: number;
}

/** When the stuck fresh-offline episode began and how much budget a reconnect may use. */
interface FreshOfflineEpisode {
  now: number;
  offlineSince: number;
  remainingMs: number;
}

/**
 * Members resolved through the client at call time, so reassigned fields keep taking effect
 * (the same convention as the other extracted units).
 */
export interface EmulatorOfflineRecoveryHost {
  timer(): Timer;
  adbFactory(): AdbClientFactory;
}

/** ADB-offline detection and bounded `adb reconnect` recovery for emulators. */
export interface EmulatorOfflineRecovery {
  maybeRecoverFreshOffline(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    context: FreshOfflineRecoveryContext,
  ): Promise<void>;
  nextPollingDelayMs(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    budget: PollingDelayBudget,
  ): number;
  getOfflineDeviceIdsAmong(
    candidateIds: Iterable<string>,
    options?: OfflineProbeOptions,
  ): Promise<Set<string>>;
  getListedNonDeviceStatesAmong(
    candidateIds: Iterable<string>,
    options?: OfflineProbeOptions,
  ): Promise<Map<string, string>>;
  recoverOfflineDevices(deviceIds: Iterable<string>, options?: OfflineProbeOptions): Promise<void>;
}

export class DefaultEmulatorOfflineRecovery implements EmulatorOfflineRecovery {
  private adbFactory(): AdbClientFactory {
    return this.host.adbFactory();
  }

  constructor(private readonly host: EmulatorOfflineRecoveryHost) {}

  /**
   * Bounded recovery for a fresh-provision cold boot whose serial is stuck in
   * ADB `offline`. Runs at most one `adb -s <serial> reconnect` re-detect once the
   * serial has been offline past {@link FRESH_OFFLINE_RECOVERY_THRESHOLD_MS}.
   * The recovery never terminates readiness: normal polling continues until the
   * caller's deadline or a terminal emulator failure (issue #7078).
   */
  async maybeRecoverFreshOffline(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    context: FreshOfflineRecoveryContext,
  ): Promise<void> {
    const { avdName, signal, startTime, timeoutMs } = context;
    if (!this.isFreshOfflineEpisode(tracker, options, deviceId)) {
      return;
    }
    const now = this.host.timer().now();
    const remainingMs = timeoutMs - (now - startTime);
    if (remainingMs <= 0) {
      return;
    }
    const offlineSince = tracker.since ?? now;

    if (!tracker.recoveryAttempted) {
      if (now - offlineSince >= FRESH_OFFLINE_RECOVERY_THRESHOLD_MS) {
        await this.dispatchFreshOfflineReconnect(
          tracker,
          deviceId!,
          { now, offlineSince, remainingMs },
          { avdName, signal },
        );
      }
    }
  }

  /** True while a fresh-provision target is actively sitting in ADB `offline`. */
  private isFreshOfflineEpisode(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
  ): boolean {
    return (
      options?.freshProvision === true &&
      Boolean(deviceId) &&
      tracker.state === "offline" &&
      tracker.since !== null
    );
  }

  nextPollingDelayMs(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    { now, pollingIntervalMs, remainingPollingTimeMs }: PollingDelayBudget,
  ): number {
    const currentDelayMs = Math.min(pollingIntervalMs, remainingPollingTimeMs);
    // After the one-shot recovery, keep polling at this cadence for the rest
    // of a fresh boot. The serial can leave `offline` before Android itself is ready.
    if (options?.freshProvision === true && tracker.recoveryAttempted) {
      return Math.min(currentDelayMs, FRESH_OFFLINE_POST_RECOVERY_POLL_INTERVAL_MS);
    }
    if (!this.isFreshOfflineEpisode(tracker, options, deviceId)) {
      return currentDelayMs;
    }
    const thresholdAt = (tracker.since ?? now) + FRESH_OFFLINE_RECOVERY_THRESHOLD_MS;
    const timeUntilThresholdMs = Math.max(0, thresholdAt - now);
    const thresholdDelayMs = Math.max(
      MIN_EMULATOR_POLLING_INTERVAL_MS,
      Math.min(currentDelayMs, timeUntilThresholdMs),
    );
    return Math.min(currentDelayMs, thresholdDelayMs);
  }

  /** Dispatch the single bounded `adb -s <serial> reconnect` re-detect for a stuck fresh boot. */
  private async dispatchFreshOfflineReconnect(
    tracker: OfflineTracker,
    deviceId: string,
    { now, offlineSince, remainingMs }: FreshOfflineEpisode,
    context: Pick<FreshOfflineRecoveryContext, "avdName" | "signal">,
  ): Promise<void> {
    const { avdName, signal } = context;
    tracker.recoveryAttempted = true;
    const commandTimeoutMs = Math.max(
      0,
      Math.min(FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS, remainingMs),
    );
    logger.warn(
      `Fresh provision '${avdName}' target ${deviceId} has been ADB-offline for ` +
        `${now - offlineSince}ms; attempting 'adb -s ${deviceId} reconnect' recovery`,
    );
    try {
      await this.issueReconnectOffline(deviceId, commandTimeoutMs, signal);
    } catch (error) {
      throwIfReadinessAborted(signal);
      // Best-effort recovery: readiness polling continues through its deadline.
      logger.warn(
        `'adb -s ${deviceId} reconnect' recovery for ${deviceId} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Issue exactly one adb -s <serial> reconnect re-detect. Shared by the
   * fresh-provision readiness recovery ({@link dispatchFreshOfflineReconnect})
   * and the disconnect monitor's in-session offline recovery
   * ({@link recoverOfflineDevices}, #7536): noRetry keeps the real AdbClient
   * from routing this through its retry executor (up to MAX_ADB_RETRIES + 1
   * executions), so one logical recovery issues exactly one reconnect command
   * (#7054).
   */
  private async issueReconnectOffline(
    deviceId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    await this.host
      .adbFactory()
      .create(null)
      .execute(["-s", deviceId, "reconnect"], { timeoutMs, noRetry: true, signal });
  }

  /**
   * Among the given candidate serials, which ones adb devices -l currently
   * reports as ADB offline rather than absent. Used by the disconnect
   * monitor to distinguish an in-session emulator that dropped its transport
   * from one that is genuinely gone (#7536): both look identical to the
   * online-only getBootedDevices filter.
   *
   * Probe failures throw AndroidOfflineProbeError so callers can distinguish
   * unavailable evidence from an authoritative empty result.
   */
  async getOfflineDeviceIdsAmong(
    candidateIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Set<string>> {
    const listed = await this.getListedNonDeviceStatesAmong(candidateIds, options);
    return new Set([...listed].filter(([, state]) => state === "offline").map(([id]) => id));
  }

  /**
   * Among the given candidate serials, every one adb devices -l lists in a
   * state other than `device` (offline, authorizing, connecting,
   * unauthorized, recovery, bootloader, sideload, no permissions), keyed to
   * that state. A listed serial is still attached even though the online-only
   * getBootedDevices filter drops it, so the disconnect monitor must not treat
   * it as unplugged (#11090).
   *
   * Probe failures throw AndroidOfflineProbeError so callers can distinguish
   * unavailable evidence from an authoritative empty result.
   */
  async getListedNonDeviceStatesAmong(
    candidateIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Map<string, string>> {
    const candidates = new Set(candidateIds);
    if (candidates.size === 0) {
      return new Map();
    }
    let states: AdbDeviceState[];
    try {
      // The candidates are devices this host held, so adb existed: an executable that has since
      // vanished (replaced mid-upgrade) is a probe that could not ask, never "listed nowhere"
      // (#11643). Callers with no candidates return above and never reach a missing adb.
      states =
        (await this.host
          .adbFactory()
          .create(null)
          .getDeviceStates?.({ ...options, throwOnMissingAdb: true })) ?? [];
    } catch (error) {
      throw new AndroidOfflineProbeError(`Device-state probe failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return new Map(
      states
        .filter((state) => state.state !== "device" && candidates.has(state.deviceId))
        .map((state) => [state.deviceId, state.state]),
    );
  }

  /**
   * Bounded, best-effort recovery for session-bound serial(s) the disconnect
   * monitor observed stuck in ADB offline (#7536). Each distinct serial gets
   * one host-serial reconnect, accepted even for an offline transport. Dispatch
   * concurrently so the sweep stays bounded by a single command timeout.
   * Never throws except on abort: a serial's recovery failure must not prevent
   * recovery of the others or fail the disconnect monitor's sweep.
   */
  async recoverOfflineDevices(
    deviceIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    throwIfReadinessAborted(options.signal);
    const timeoutMs = options.timeoutMs ?? FRESH_OFFLINE_RECOVERY_COMMAND_TIMEOUT_MS;
    await Promise.all(
      [...new Set(deviceIds)].map(async (deviceId) => {
        try {
          await this.issueReconnectOffline(deviceId, timeoutMs, options.signal);
        } catch (error) {
          throwIfReadinessAborted(options.signal);
          // Best-effort recovery: other serials and the disconnect sweep continue.
          logger.warn(
            `'adb -s ${deviceId} reconnect' recovery for in-session offline device failed: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
    throwIfReadinessAborted(options.signal);
  }
}
