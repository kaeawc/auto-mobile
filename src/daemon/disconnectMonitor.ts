import type { Platform } from "../models";

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
  candidatePlatforms: Map<string, Platform>;
  candidateIncarnations?: Map<string, DisconnectCandidateIncarnation>;
  deviceDisconnectMissIncarnations?: Map<string, DisconnectCandidateIncarnation>;
  forceDisconnectedDeviceIds?: Set<string>;
  missThreshold: number;
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
    input.deviceDisconnectMisses.delete(deviceId);
    deviceDisconnectMissIncarnations.delete(deviceId);
  };

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

    if (forceDisconnectedDeviceIds.has(deviceId)) {
      clearMiss(deviceId);
      disconnected.push(deviceId);
      continue;
    }
  }

  if (disconnected.length > 0) {
    return { disconnected, missed, skippedAllDiscoveryFailed: false };
  }

  if (
    input.bootedDeviceIds.size === 0 &&
    input.candidateDeviceIds.size > 0 &&
    input.succeededPlatforms.size === 0
  ) {
    return { disconnected, missed, skippedAllDiscoveryFailed: true };
  }

  for (const deviceId of input.candidateDeviceIds) {
    if (input.bootedDeviceIds.has(deviceId)) {
      clearMiss(deviceId);
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
      continue;
    }

    if (candidateIncarnations.has(deviceId)) {
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
    }

    if (input.confirmedDisconnectedDeviceIds.has(deviceId)) {
      clearMiss(deviceId);
      continue;
    }

    const platform = input.candidatePlatforms.get(deviceId);
    if (platform && !input.succeededPlatforms.has(platform)) {
      clearMiss(deviceId);
      continue;
    }

    const candidateIncarnation = candidateIncarnations.get(deviceId);
    const priorMisses =
      candidateIncarnation === deviceDisconnectMissIncarnations.get(deviceId)
        ? (input.deviceDisconnectMisses.get(deviceId) ?? 0)
        : 0;
    const misses = Math.min(priorMisses + 1, input.missThreshold);
    input.deviceDisconnectMisses.set(deviceId, misses);
    if (candidateIncarnation === undefined) {
      deviceDisconnectMissIncarnations.delete(deviceId);
    } else {
      deviceDisconnectMissIncarnations.set(deviceId, candidateIncarnation);
    }
    missed.push({ deviceId, misses });
    if (misses >= input.missThreshold) {
      disconnected.push(deviceId);
    }
  }

  return { disconnected, missed, skippedAllDiscoveryFailed: false };
}
