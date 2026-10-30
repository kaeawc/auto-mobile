import type { Platform } from "../models";
import {
  didSourceSucceedForDevice,
  discoverySourceFor,
  type DiscoverySource,
} from "../utils/discoverySource";
import { isPhysicalAndroidUsbSerial } from "../utils/androidSerial";
import type { AdbTransportRestartLookup } from "../utils/android-cmdline-tools/AdbTransportRestartRegistry";
import { MISSING_DEVICE_MISS_THRESHOLD, type DeviceLossMisses } from "./deviceLossMisses";

export type DisconnectCandidateIncarnation = number | string;

interface RecordingDisconnectCandidate {
  deviceId: string;
  recordingId: string;
}

/**
 * Derive a stable lifecycle marker for recording-only candidates. A device ID
 * can be reused immediately after a recording stops, so its active recording
 * IDs are the only identity evidence available when it is not pooled.
 */
export function recordingCandidateIncarnations(
  recordings: Iterable<RecordingDisconnectCandidate>,
): Map<string, DisconnectCandidateIncarnation> {
  const recordingIdsByDevice = new Map<string, string[]>();
  for (const recording of recordings) {
    const recordingIds = recordingIdsByDevice.get(recording.deviceId) ?? [];
    recordingIds.push(recording.recordingId);
    recordingIdsByDevice.set(recording.deviceId, recordingIds);
  }

  return new Map(
    [...recordingIdsByDevice].map(([deviceId, recordingIds]) => [
      deviceId,
      `recordings:${recordingIds.sort().join("\u0000")}`,
    ]),
  );
}

/**
 * How long a candidate may stay listed in a transitional platform state before
 * the monitor treats it as lost (#11090, #11592). A loaded host can hold a
 * running emulator `offline`, or a restarting simulator `Booting`, well past
 * the 3-sweep absent debounce (~10 s); releasing its session then drops a
 * working device. A device the platform no longer lists at all keeps the
 * 3-miss rule, and an emulator AutoMobile launched is evicted on process exit
 * by its own watcher, so this budget only bounds devices that never settle.
 */
export const OFFLINE_DEVICE_DISCONNECT_BUDGET_MS = 60_000;

/** Bound simulator absence after a successful miss, even if later simctl sweeps fail. */
export const MISSING_SIMULATOR_DISCONNECT_BUDGET_MS = 60_000;

/**
 * The `adb devices` states that mean "attached and settling": the transport is
 * re-attaching (`offline`) or waiting on the authorization prompt
 * (`unauthorized`). An emulator that is listed `device` before boot completes
 * is already in the booted listing, so it never reaches this check. Other
 * non-`device` rows (recovery, bootloader, sideload, no permissions) are not
 * on their way back to `device` and keep the absent debounce.
 */
export function isTransitionalAdbState(state: string): boolean {
  return state === "offline" || state === "unauthorized";
}

/**
 * This sweep's candidates the platform still lists in a transitional state:
 * adb `offline`/`unauthorized` serials and `simctl` `Booting`/`Shutting Down`
 * simulators (#11592). One set, so the evaluator holds both platforms under
 * the same budget. An undefined adb half (probe failed or skipped) contributes
 * nothing, which leaves those serials on ordinary miss counting.
 */
export function selectTransitionalDeviceIds(
  transitionalAdbDeviceIds: ReadonlySet<string> | undefined,
  transitionalSimulatorIds: Iterable<string>,
): Set<string> {
  return new Set([...(transitionalAdbDeviceIds ?? []), ...transitionalSimulatorIds]);
}

/** Independent transitional and simulator-absence clocks, keyed to the candidate incarnation. */
export interface OfflineEpisode {
  sinceMs?: number;
  missingSinceMs?: number;
  incarnation: DisconnectCandidateIncarnation | undefined;
}

export interface DisconnectMonitorEvaluation {
  disconnected: string[];
  /** `budgetExhausted` marks a candidate released by a time bound rather than miss counting. */
  missed: Array<{ deviceId: string; misses: number; budgetExhausted?: true }>;
  /** Candidates held in a transitional platform state this sweep instead of counting a miss. */
  transitional: Array<{ deviceId: string; transitionalForMs: number }>;
  skippedAllDiscoveryFailed: boolean;
}

export interface DisconnectMonitorEvaluationInput {
  deviceDisconnectMisses: DeviceLossMisses;
  confirmedDisconnectedDeviceIds: Set<string>;
  bootedDeviceIds: Set<string>;
  candidateDeviceIds: Set<string>;
  succeededPlatforms: Set<Platform>;
  /**
   * Per-source completeness (#5683). Optional: absent, every check falls back
   * to the platform aggregate, which is what callers did before iOS grew a
   * second discovery source.
   */
  succeededSources?: Set<DiscoverySource>;
  candidatePlatforms: Map<string, Platform>;
  candidateIncarnations?: Map<string, DisconnectCandidateIncarnation>;
  deviceDisconnectMissIncarnations?: Map<string, DisconnectCandidateIncarnation>;
  forceDisconnectedDeviceIds?: Set<string>;
  /**
   * Candidates whose absence from a successful listing is definitive, so one
   * miss confirms the disconnect instead of the multi-sweep debounce (#10493).
   * Build it with {@link selectImmediateDisconnectCandidates}.
   */
  immediateDisconnectDeviceIds?: ReadonlySet<string>;
  /**
   * Candidates the platform still lists in a transitional state this sweep
   * (#11090, #11592); build it with {@link selectTransitionalDeviceIds}. With
   * {@link offlineEpisodes} and {@link nowMs}, these sweeps neither count nor
   * reset an absent miss; the candidate is disconnected once its episode
   * reaches {@link offlineBudgetMs}. A candidate not in the set (including
   * when a probe failed or was skipped) falls back to ordinary miss counting.
   */
  transitionalDeviceIds?: ReadonlySet<string>;
  offlineEpisodes?: Map<string, OfflineEpisode>;
  nowMs?: number;
  offlineBudgetMs?: number;
  /** Simulator-only bound from the first successful miss; unknown-only sweeps never start it. */
  missingSimulatorBudgetMs?: number;
}

/**
 * Physical USB Android candidates absent from this sweep's `adb devices`
 * listing in every state (#10493, #11090). Unplugging a phone or dropping its
 * transport removes it from `adb devices`, which a physical device does not do
 * transiently the way an emulator restart or wireless transport can, so its
 * sessions are released on the first miss. A serial still listed in any
 * non-`device` state (offline, authorizing after an adbd restart or USB
 * re-enumeration, connecting, unauthorized, recovery, bootloader, sideload,
 * no permissions) is attached and keeps the normal debounce. Emulators and
 * TCP/mDNS transports keep the debounce, as does a serial whose adbd
 * AutoMobile is restarting (`adb root`/`unroot`, plus a short grace). An
 * unknown listing (probe failed or skipped) selects nothing, and the evaluator
 * still requires the Android source to have succeeded, so a failed or partial
 * listing never fast-paths a release.
 */
export function selectImmediateDisconnectCandidates(
  candidateDeviceIds: ReadonlySet<string>,
  candidatePlatforms: ReadonlyMap<string, Platform>,
  bootedDeviceIds: ReadonlySet<string>,
  listedNonDeviceIds: ReadonlySet<string> | undefined,
  transportRestarts?: AdbTransportRestartLookup,
): Set<string> {
  if (listedNonDeviceIds === undefined) {
    return new Set();
  }
  return new Set(
    [...candidateDeviceIds].filter(
      (deviceId) =>
        candidatePlatforms.get(deviceId) === "android" &&
        isPhysicalAndroidUsbSerial(deviceId) &&
        !bootedDeviceIds.has(deviceId) &&
        !listedNonDeviceIds.has(deviceId) &&
        transportRestarts?.isRestarting(deviceId) !== true,
    ),
  );
}

/**
 * Drop attempted-recovery entries for devices no longer worth tracking: gone
 * from the candidate set (session ended / device removed) or no longer
 * observed `offline` (recovered, or now genuinely absent). Keeping the
 * attempted-set pruned lets a LATER offline episode for the same serial
 * trigger a fresh recovery attempt rather than being silently skipped
 * forever (#7536).
 *
 * An undefined offline result means the probe failed: retain episode state
 * unless the candidate disappeared or its incarnation changed.
 */
export function pruneStaleOfflineRecoveryAttempts(
  attempted: ReadonlySet<string>,
  candidateDeviceIds: ReadonlySet<string>,
  offlineDeviceIds: ReadonlySet<string> | undefined,
  attemptedIncarnations: ReadonlyMap<string, DisconnectCandidateIncarnation> = new Map(),
  candidateIncarnations: ReadonlyMap<string, DisconnectCandidateIncarnation> = new Map(),
): Set<string> {
  return new Set(
    [...attempted].filter(
      (deviceId) =>
        candidateDeviceIds.has(deviceId) &&
        (offlineDeviceIds === undefined || offlineDeviceIds.has(deviceId)) &&
        attemptedIncarnations.get(deviceId) === candidateIncarnations.get(deviceId),
    ),
  );
}

/**
 * Session-bound serials seen ADB `offline` this sweep that have not yet had
 * a bounded `adb -s <serial> reconnect` recovery attempt this episode (#7536).
 * Recovery is one-shot per episode: once a serial is marked attempted (by the
 * caller, using this function's return value), it is not retried again until
 * {@link pruneStaleOfflineRecoveryAttempts} clears it — either because the
 * serial recovered/left `offline`, or because it dropped out of the
 * candidate set entirely.
 *
 * Excludes any serial with an in-flight `provisionDevice`/`startDevice` lease
 * (`inFlightStartupDeviceIds`): `AndroidEmulatorClient`'s own fresh-provision
 * readiness wait (`maybeRecoverFreshOffline`, #7054/#7078) already owns
 * bounded offline recovery for that serial on its own 15s threshold, so this
 * monitor-level reconnect would be redundant at best and, at worst, a second
 * concurrent `adb -s <serial> reconnect` racing the readiness wait's own dispatch.
 */
export function selectOfflineRecoveryCandidates(
  offlineDeviceIds: ReadonlySet<string>,
  candidateDeviceIds: ReadonlySet<string>,
  alreadyAttempted: ReadonlySet<string>,
  inFlightStartupDeviceIds: ReadonlySet<string> = new Set(),
): string[] {
  return [...offlineDeviceIds].filter(
    (deviceId) =>
      candidateDeviceIds.has(deviceId) &&
      !alreadyAttempted.has(deviceId) &&
      !inFlightStartupDeviceIds.has(deviceId),
  );
}

/**
 * End transitional episodes for candidates that left the candidate set, are
 * booted again, or now name a different incarnation. Absent sweeps do not end
 * an episode, so transitional/absent flapping stays bounded by the budget.
 */
function pruneOfflineEpisodes(
  offlineEpisodes: Map<string, OfflineEpisode> | undefined,
  input: Pick<DisconnectMonitorEvaluationInput, "candidateDeviceIds" | "bootedDeviceIds">,
  candidateIncarnations: ReadonlyMap<string, DisconnectCandidateIncarnation>,
): void {
  for (const [deviceId, episode] of offlineEpisodes ?? []) {
    if (
      !input.candidateDeviceIds.has(deviceId) ||
      input.bootedDeviceIds.has(deviceId) ||
      episode.incarnation !== candidateIncarnations.get(deviceId)
    ) {
      offlineEpisodes?.delete(deviceId);
    }
  }
}

function candidateSourceSucceeded(
  input: DisconnectMonitorEvaluationInput,
  deviceId: string,
): boolean {
  // Forced detached sessions originate from Android ADB recovery. Unknown
  // candidates without that evidence cannot be attributed to a source.
  const platform =
    input.candidatePlatforms.get(deviceId) ??
    (input.forceDisconnectedDeviceIds?.has(deviceId) ? "android" : undefined);
  return platform !== undefined && didSourceSucceedForDevice(input, platform, deviceId);
}

function simulatorAbsenceBudgetExhausted(
  input: DisconnectMonitorEvaluationInput,
  deviceId: string,
  sourceSucceeded: boolean,
): boolean {
  const platform = input.candidatePlatforms.get(deviceId);
  if (
    !platform ||
    discoverySourceFor(platform, deviceId) !== "ios-simulator" ||
    input.offlineEpisodes === undefined ||
    input.nowMs === undefined
  ) {
    return false;
  }
  const episode = input.offlineEpisodes.get(deviceId) ?? {
    incarnation: input.candidateIncarnations?.get(deviceId),
  };
  if (sourceSucceeded) {
    episode.missingSinceMs ??= input.nowMs;
    input.offlineEpisodes.set(deviceId, episode);
  }
  return (
    episode.missingSinceMs !== undefined &&
    input.nowMs - episode.missingSinceMs >=
      (input.missingSimulatorBudgetMs ?? MISSING_SIMULATOR_DISCONNECT_BUDGET_MS)
  );
}

export function evaluateDeviceDisconnects(
  input: DisconnectMonitorEvaluationInput,
): DisconnectMonitorEvaluation {
  const disconnected: string[] = [];
  const missed: DisconnectMonitorEvaluation["missed"] = [];
  const transitional: Array<{ deviceId: string; transitionalForMs: number }> = [];
  const offlineEpisodes = input.offlineEpisodes;
  const forceDisconnectedDeviceIds = input.forceDisconnectedDeviceIds ?? new Set<string>();
  const candidateIncarnations = input.candidateIncarnations ?? new Map<string, number>();
  const deviceDisconnectMissIncarnations =
    input.deviceDisconnectMissIncarnations ?? new Map<string, number>();
  const clearMiss = (deviceId: string): void => {
    input.deviceDisconnectMisses.observe(deviceId, "present");
    deviceDisconnectMissIncarnations.delete(deviceId);
  };

  const clearStaleCandidates = (): void => {
    for (const deviceId of input.confirmedDisconnectedDeviceIds) {
      if (!input.candidateDeviceIds.has(deviceId)) {
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
      }
    }

    for (const deviceId of input.deviceDisconnectMisses.deviceIds()) {
      if (!input.candidateDeviceIds.has(deviceId)) {
        clearMiss(deviceId);
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
      }
    }

    for (const deviceId of input.candidateDeviceIds) {
      const countedIncarnation = deviceDisconnectMissIncarnations.get(deviceId);
      if (
        countedIncarnation !== undefined &&
        countedIncarnation !== candidateIncarnations.get(deviceId)
      ) {
        clearMiss(deviceId);
      }
      if (input.bootedDeviceIds.has(deviceId)) {
        clearMiss(deviceId);
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
        forceDisconnectedDeviceIds.delete(deviceId);
        continue;
      }
    }
  };

  const confirmBudgetExhausted = (deviceId: string): void => {
    input.deviceDisconnectMisses.set(deviceId, MISSING_DEVICE_MISS_THRESHOLD);
    missed.push({ deviceId, misses: MISSING_DEVICE_MISS_THRESHOLD, budgetExhausted: true });
    disconnected.push(deviceId);
  };

  const recordMiss = (deviceId: string): void => {
    const candidateIncarnation = candidateIncarnations.get(deviceId);
    const observed = input.deviceDisconnectMisses.observe(deviceId, "missing");
    const immediate = input.immediateDisconnectDeviceIds?.has(deviceId) === true;
    if (immediate) {
      input.deviceDisconnectMisses.set(deviceId, MISSING_DEVICE_MISS_THRESHOLD);
    }
    const misses = immediate ? MISSING_DEVICE_MISS_THRESHOLD : observed.misses;
    const confirmedGone = immediate || observed.confirmedGone;
    if (candidateIncarnation === undefined) {
      deviceDisconnectMissIncarnations.delete(deviceId);
    } else {
      deviceDisconnectMissIncarnations.set(deviceId, candidateIncarnation);
    }
    missed.push({ deviceId, misses });
    if (confirmedGone) {
      disconnected.push(deviceId);
    }
  };

  /**
   * Hold a candidate the platform lists in a transitional state: it is not
   * gone, and its absent miss streak is neither advanced nor reset. The
   * episode survives interleaved absent sweeps, so transitional/absent
   * flapping is still bounded by the budget or the absent debounce, and a
   * candidate that then leaves the listing (a simulator reaching `Shutdown`)
   * is released on the absent debounce rather than a fresh budget.
   */
  const holdTransitional = (
    deviceId: string,
    nowMs: number,
    episodes: Map<string, OfflineEpisode>,
  ) => {
    const episode = episodes.get(deviceId) ?? {
      incarnation: candidateIncarnations.get(deviceId),
    };
    episode.sinceMs ??= nowMs;
    episodes.set(deviceId, episode);
    const transitionalForMs = nowMs - episode.sinceMs;
    if (transitionalForMs < (input.offlineBudgetMs ?? OFFLINE_DEVICE_DISCONNECT_BUDGET_MS)) {
      transitional.push({ deviceId, transitionalForMs });
      return;
    }
    confirmBudgetExhausted(deviceId);
  };

  const evaluateCandidate = (deviceId: string): void => {
    if (input.bootedDeviceIds.has(deviceId)) {
      clearMiss(deviceId);
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
      return;
    }

    if (candidateIncarnations.has(deviceId)) {
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
    }

    if (input.confirmedDisconnectedDeviceIds.has(deviceId)) {
      clearMiss(deviceId);
      return;
    }

    // Only the source that would have listed this device can call it missing:
    // a failed simctl sweep must not age out a devicectl-confirmed iPhone, and
    // a failed devicectl sweep must not age out a booted simulator (#5683).
    const sourceSucceeded = candidateSourceSucceeded(input, deviceId);
    if (!sourceSucceeded) {
      input.deviceDisconnectMisses.observe(deviceId, "source-unavailable");
      if (simulatorAbsenceBudgetExhausted(input, deviceId, false)) {
        confirmBudgetExhausted(deviceId);
      }
      return;
    }

    if (
      input.transitionalDeviceIds?.has(deviceId) === true &&
      offlineEpisodes !== undefined &&
      input.nowMs !== undefined
    ) {
      holdTransitional(deviceId, input.nowMs, offlineEpisodes);
      return;
    }

    if (simulatorAbsenceBudgetExhausted(input, deviceId, true)) {
      confirmBudgetExhausted(deviceId);
      return;
    }
    recordMiss(deviceId);
  };

  clearStaleCandidates();
  pruneOfflineEpisodes(offlineEpisodes, input, candidateIncarnations);
  const allDiscoveryFailed =
    input.bootedDeviceIds.size === 0 &&
    input.candidateDeviceIds.size > 0 &&
    input.succeededPlatforms.size === 0 &&
    (input.succeededSources?.size ?? 0) === 0;

  for (const deviceId of input.candidateDeviceIds) {
    evaluateCandidate(deviceId);
  }

  return {
    disconnected,
    missed,
    transitional,
    skippedAllDiscoveryFailed: allDiscoveryFailed && disconnected.length === 0,
  };
}
