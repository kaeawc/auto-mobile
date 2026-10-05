import type { Platform } from "../models";
import { didSourceSucceedForDevice, type DiscoverySource } from "../utils/discoverySource";
import { observeMissingDevice } from "./missingDeviceLiveness";

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

export interface DisconnectMonitorEvaluation {
  disconnected: string[];
  missed: Array<{ deviceId: string; misses: number }>;
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

export function evaluateDeviceDisconnects(
  input: DisconnectMonitorEvaluationInput,
): DisconnectMonitorEvaluation {
  const disconnected: string[] = [];
  const missed: Array<{ deviceId: string; misses: number }> = [];
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
    const { misses, confirmedGone } = observeMissingDevice(
      input.deviceDisconnectMisses,
      deviceId,
      "missing",
    );
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

    recordMiss(deviceId);
  };

  clearStaleCandidates();
  if (
    input.bootedDeviceIds.size === 0 &&
    input.candidateDeviceIds.size > 0 &&
    input.succeededPlatforms.size === 0 &&
    (input.succeededSources?.size ?? 0) === 0
  ) {
    for (const deviceId of input.candidateDeviceIds) {
      clearMiss(deviceId);
    }
    return { disconnected, missed, skippedAllDiscoveryFailed: true };
  }

  for (const deviceId of input.candidateDeviceIds) {
    evaluateCandidate(deviceId);
  }

  return { disconnected, missed, skippedAllDiscoveryFailed: false };
}
