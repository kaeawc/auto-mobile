import type { Platform } from "../models";
import { didSourceSucceedForDevice, type DiscoverySource } from "../utils/discoverySource";
import { isPhysicalAndroidUsbSerial } from "../utils/androidSerial";
import type { AdbTransportRestartLookup } from "../utils/android-cmdline-tools/AdbTransportRestartRegistry";
import { MISSING_DEVICE_MISS_THRESHOLD, observeMissingDevice } from "./missingDeviceLiveness";

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
 * How long a candidate may stay ADB `offline` before the monitor treats it as
 * lost (#11090). A loaded host can hold a running emulator `offline` well past
 * the 3-sweep absent debounce (~10 s); releasing its session then drops a
 * working device. Truly absent serials keep the 3-miss rule, and an emulator
 * AutoMobile launched is evicted on process exit by its own watcher, so this
 * budget only bounds external emulators and devices whose transport never
 * returns.
 */
export const OFFLINE_DEVICE_DISCONNECT_BUDGET_MS = 60_000;

/** Start of a candidate's current ADB `offline` episode, keyed to its incarnation. */
export interface OfflineEpisode {
  sinceMs: number;
  incarnation: DisconnectCandidateIncarnation | undefined;
}

export interface DisconnectMonitorEvaluation {
  disconnected: string[];
  missed: Array<{ deviceId: string; misses: number }>;
  /** Candidates held as ADB `offline` this sweep instead of counting a miss. */
  offline: Array<{ deviceId: string; offlineForMs: number }>;
  skippedAllDiscoveryFailed: boolean;
}

export interface DisconnectMonitorEvaluationInput {
  deviceDisconnectMisses: Map<string, number>;
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
   * Candidates `adb devices` lists as `offline` this sweep (#11090). With
   * {@link offlineEpisodes} and {@link nowMs}, these sweeps neither count nor
   * reset an absent miss; the candidate is disconnected once its offline
   * episode exceeds {@link offlineBudgetMs}. Undefined (probe failed or
   * skipped) falls back to ordinary miss counting.
   */
  offlineDeviceIds?: ReadonlySet<string>;
  offlineEpisodes?: Map<string, OfflineEpisode>;
  nowMs?: number;
  offlineBudgetMs?: number;
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
 * a bounded `adb reconnect offline` recovery attempt this episode (#7536).
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
 * concurrent `adb reconnect offline` racing the readiness wait's own dispatch.
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
 * End offline episodes for candidates that left the candidate set, came back
 * as `device`, or now name a different incarnation. Absent sweeps do not end
 * an episode, so offline/absent flapping stays bounded by the budget.
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

export function evaluateDeviceDisconnects(
  input: DisconnectMonitorEvaluationInput,
): DisconnectMonitorEvaluation {
  const disconnected: string[] = [];
  const missed: Array<{ deviceId: string; misses: number }> = [];
  const offline: Array<{ deviceId: string; offlineForMs: number }> = [];
  const offlineEpisodes = input.offlineEpisodes;
  const forceDisconnectedDeviceIds = input.forceDisconnectedDeviceIds ?? new Set<string>();
  const candidateIncarnations = input.candidateIncarnations ?? new Map<string, number>();
  const deviceDisconnectMissIncarnations =
    input.deviceDisconnectMissIncarnations ?? new Map<string, number>();
  const clearMiss = (deviceId: string): void => {
    observeMissingDevice(input.deviceDisconnectMisses, deviceId, "present");
    deviceDisconnectMissIncarnations.delete(deviceId);
  };

  const clearStaleCandidates = (): void => {
    for (const deviceId of input.confirmedDisconnectedDeviceIds) {
      if (!input.candidateDeviceIds.has(deviceId)) {
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
      }
    }

    for (const deviceId of input.deviceDisconnectMisses.keys()) {
      if (!input.candidateDeviceIds.has(deviceId)) {
        clearMiss(deviceId);
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
      }
    }

    for (const deviceId of input.candidateDeviceIds) {
      if (input.bootedDeviceIds.has(deviceId)) {
        clearMiss(deviceId);
        input.confirmedDisconnectedDeviceIds.delete(deviceId);
        forceDisconnectedDeviceIds.delete(deviceId);
        continue;
      }
    }
  };

  const recordMiss = (deviceId: string): void => {
    const candidateIncarnation = candidateIncarnations.get(deviceId);
    const countedIncarnation = deviceDisconnectMissIncarnations.get(deviceId);
    const priorMisses =
      countedIncarnation === undefined || candidateIncarnation === countedIncarnation
        ? (input.deviceDisconnectMisses.get(deviceId) ?? 0)
        : 0;
    if (priorMisses === 0) {
      input.deviceDisconnectMisses.delete(deviceId);
    }
    const observed = observeMissingDevice(input.deviceDisconnectMisses, deviceId, "missing");
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
   * Hold an ADB-offline candidate: the transport is listed, so the device is
   * not gone, and its absent miss streak is neither advanced nor reset. The
   * episode survives interleaved absent sweeps, so offline/absent flapping is
   * still bounded by the budget or the absent debounce.
   */
  const holdOffline = (deviceId: string, nowMs: number, episodes: Map<string, OfflineEpisode>) => {
    const episode = episodes.get(deviceId) ?? {
      sinceMs: nowMs,
      incarnation: candidateIncarnations.get(deviceId),
    };
    episodes.set(deviceId, episode);
    const offlineForMs = nowMs - episode.sinceMs;
    if (offlineForMs < (input.offlineBudgetMs ?? OFFLINE_DEVICE_DISCONNECT_BUDGET_MS)) {
      offline.push({ deviceId, offlineForMs });
      return;
    }
    input.deviceDisconnectMisses.set(deviceId, MISSING_DEVICE_MISS_THRESHOLD);
    missed.push({ deviceId, misses: MISSING_DEVICE_MISS_THRESHOLD });
    disconnected.push(deviceId);
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
    //
    // Forced detached sessions originate from Android ADB recovery. Unknown
    // candidates without that evidence still cannot be attributed to a source.
    const platform =
      input.candidatePlatforms.get(deviceId) ??
      (forceDisconnectedDeviceIds.has(deviceId) ? "android" : undefined);
    if (!platform || !didSourceSucceedForDevice(input, platform, deviceId)) {
      observeMissingDevice(input.deviceDisconnectMisses, deviceId, "source-unavailable");
      deviceDisconnectMissIncarnations.delete(deviceId);
      return;
    }

    if (
      input.offlineDeviceIds?.has(deviceId) === true &&
      offlineEpisodes !== undefined &&
      input.nowMs !== undefined
    ) {
      holdOffline(deviceId, input.nowMs, offlineEpisodes);
      return;
    }

    recordMiss(deviceId);
  };

  clearStaleCandidates();
  pruneOfflineEpisodes(offlineEpisodes, input, candidateIncarnations);
  if (
    input.bootedDeviceIds.size === 0 &&
    input.candidateDeviceIds.size > 0 &&
    input.succeededPlatforms.size === 0 &&
    (input.succeededSources?.size ?? 0) === 0
  ) {
    for (const deviceId of input.candidateDeviceIds) {
      clearMiss(deviceId);
    }
    return { disconnected, missed, offline, skippedAllDiscoveryFailed: true };
  }

  for (const deviceId of input.candidateDeviceIds) {
    evaluateCandidate(deviceId);
  }

  return { disconnected, missed, offline, skippedAllDiscoveryFailed: false };
}
